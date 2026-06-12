export const AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS = ['browsingActivity', 'technicalAndInteraction', 'websiteContent'] as const

type AgentBridgeDataCollectionPermission = (typeof AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS)[number]
type DataCollectionPermissionRequest = { data_collection: AgentBridgeDataCollectionPermission[] }
export type AgentBridgeDataConsentSnapshot = {
  supported: boolean
  granted: AgentBridgeDataCollectionPermission[]
  missing: AgentBridgeDataCollectionPermission[]
}
type DataCollectionPermissionsApi = {
  getAll?: () => Promise<{ data_collection?: string[] }>
  request?: (permissions: DataCollectionPermissionRequest) => Promise<boolean>
  remove?: (permissions: DataCollectionPermissionRequest) => Promise<boolean>
}
type DataCollectionPermissionSet = Record<string, unknown> & {
  data_collection?: unknown
}

const declaredAgentBridgeDataCollectionPermissions = (): Set<string> | null => {
  const manifest = globalThis.chrome?.runtime?.getManifest?.() as
    | {
        browser_specific_settings?: {
          gecko?: {
            data_collection_permissions?: {
              optional?: unknown
            }
          }
        }
      }
    | undefined
  const optional = manifest?.browser_specific_settings?.gecko?.data_collection_permissions?.optional
  if (!Array.isArray(optional)) return null
  return new Set(optional.filter((permission): permission is string => typeof permission === 'string'))
}

const supportsAgentBridgeDataCollectionPermissions = (): boolean => {
  const declared = declaredAgentBridgeDataCollectionPermissions()
  if (!declared) return false
  return AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.every(permission => declared.has(permission))
}

const dataCollectionSet = (permissions: unknown): Set<string> | null => {
  if (!permissions || typeof permissions !== 'object') return null
  const dataCollection = (permissions as DataCollectionPermissionSet).data_collection
  if (!Array.isArray(dataCollection)) return null
  return new Set(dataCollection.filter((permission): permission is string => typeof permission === 'string'))
}

const dataCollectionPermissionsApi = (): DataCollectionPermissionsApi | null => {
  const permissions = globalThis.chrome?.permissions
  if (!supportsAgentBridgeDataCollectionPermissions()) return null
  if (!permissions?.getAll) return null
  return permissions as DataCollectionPermissionsApi
}

const dataCollectionPermissionRequestApi = (): Pick<DataCollectionPermissionsApi, 'request'> | null => {
  const permissions = globalThis.chrome?.permissions
  if (!supportsAgentBridgeDataCollectionPermissions()) return null
  if (!permissions?.request) return null
  return permissions as Pick<DataCollectionPermissionsApi, 'request'>
}

const dataCollectionPermissionRemoveApi = (): Pick<DataCollectionPermissionsApi, 'remove'> | null => {
  const permissions = globalThis.chrome?.permissions
  if (!supportsAgentBridgeDataCollectionPermissions()) return null
  if (!permissions?.remove) return null
  return permissions as Pick<DataCollectionPermissionsApi, 'remove'>
}

const grantedDataCollectionPermissions = async (permissions: DataCollectionPermissionsApi): Promise<Set<string> | null> => {
  return dataCollectionSet(await permissions.getAll!())
}

const snapshotFromGrantedPermissions = (granted: Set<string>): AgentBridgeDataConsentSnapshot => {
  const grantedCategories = AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.filter(permission => granted.has(permission))
  const missingCategories = AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.filter(permission => !granted.has(permission))
  return { supported: true, granted: grantedCategories, missing: missingCategories }
}

const unsupportedDataConsentSnapshot = (): AgentBridgeDataConsentSnapshot => ({
  supported: false,
  granted: [...AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS],
  missing: []
})

export const includesAgentBridgeDataConsentRemoval = (permissions: unknown): boolean => {
  const removed = dataCollectionSet(permissions)
  if (!removed) return false
  return AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.some(permission => removed.has(permission))
}

export const loadAgentBridgeDataConsentSnapshot = async (): Promise<AgentBridgeDataConsentSnapshot> => {
  const permissions = dataCollectionPermissionsApi()
  if (!permissions) return unsupportedDataConsentSnapshot()
  const granted = await grantedDataCollectionPermissions(permissions)
  if (!granted) return unsupportedDataConsentSnapshot()
  return snapshotFromGrantedPermissions(granted)
}

export const hasAgentBridgeDataConsent = async (): Promise<boolean> => {
  return (await loadAgentBridgeDataConsentSnapshot()).missing.length === 0
}

export const requestAgentBridgeDataConsent = (): Promise<boolean> => {
  const permissions = dataCollectionPermissionRequestApi()
  if (!permissions) return Promise.resolve(true)
  return permissions.request!({ data_collection: [...AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS] })
}

export const rollbackAgentBridgeDataConsent = async (snapshot: AgentBridgeDataConsentSnapshot | null | undefined): Promise<boolean> => {
  if (!snapshot?.supported) return false
  const previouslyGranted = new Set(snapshot.granted)
  const grantedByRequest = AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.filter(permission => !previouslyGranted.has(permission))
  if (!grantedByRequest.length) return false
  const permissions = dataCollectionPermissionRemoveApi()
  if (!permissions) throw new Error('Agent Bridge data consent removal is unavailable.')
  const removed = await permissions.remove!({ data_collection: grantedByRequest })
  if (!removed) throw new Error('Agent Bridge data consent removal was rejected.')
  return true
}

export const revokeAgentBridgeDataConsent = async (): Promise<boolean> => {
  const permissions = dataCollectionPermissionsApi()
  if (!permissions) return false
  const granted = await grantedDataCollectionPermissions(permissions)
  if (!granted) return false
  const grantedCategories = AGENT_BRIDGE_DATA_COLLECTION_PERMISSIONS.filter(permission => granted.has(permission))
  if (!grantedCategories.length) return false
  const removePermissions = dataCollectionPermissionRemoveApi()
  if (!removePermissions) throw new Error('Agent Bridge data consent removal is unavailable.')
  const removed = await removePermissions.remove!({ data_collection: grantedCategories })
  if (!removed) throw new Error('Agent Bridge data consent removal was rejected.')
  return true
}
