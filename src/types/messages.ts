import type { DynamicSnapshot, PageDetectionResult } from './rules'
import type { HeaderRecord, PopupRawResult, PopupResult } from './popup'
import type { AgentBridgeCapabilities, AgentBridgeRuntimeMessage, AgentCaptureStatusPayload, AgentBridgeError } from './agent-bridge'

export type Message =
  | { type: 'GET_HEADER_DATA'; tabId: number }
  | { type: 'GET_POPUP_RESULT'; tabId: number }
  | { type: 'GET_POPUP_RAW_RESULT'; tabId: number }
  | { type: 'GET_TECH_LINK'; name: string }
  | { type: 'START_BACKGROUND_DETECTION'; tabId: number }
  | { type: 'GET_WORDPRESS_THEME_DETAILS'; page: PageDetectionResult }
  | { type: 'DYNAMIC_PAGE_SNAPSHOT'; snapshot: DynamicSnapshot }
  | { type: 'PAGE_DETECTION_RESULT'; tabId: number; page: PageDetectionResult }
  | AgentBridgeRuntimeMessage

export type MessageType = Message['type']

export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string }
export type Response<T> = Ok<T> | Err

export interface PopupCachedResponse extends Ok<PopupResult> {
  hasCache: boolean
  stale: boolean
  updatedAt: number
}

export type ResponsePayloadMap = {
  GET_HEADER_DATA: Response<HeaderRecord[]>
  GET_POPUP_RESULT: PopupCachedResponse | Err
  GET_POPUP_RAW_RESULT: Response<PopupRawResult>
  GET_TECH_LINK: { ok: true; url: string } | Err
  START_BACKGROUND_DETECTION: Ok<null> | Err
  GET_WORDPRESS_THEME_DETAILS: Ok<{ technologies: PageDetectionResult['technologies'] }> | Err
  DYNAMIC_PAGE_SNAPSHOT: Ok<null> | Err
  PAGE_DETECTION_RESULT: Ok<null> | Err
  AGENT_BRIDGE_HELLO: Ok<{ extensionVersion: string; protocolVersion: 1; capabilities: AgentBridgeCapabilities }> | Err
  START_AGENT_CAPTURE: Ok<null> | Err
  AGENT_CAPTURE_STATUS: Ok<null> | Err
  AGENT_CAPTURE_CONTROL: Ok<null> | Err
  AGENT_PROFILE_TRANSFER_BEGIN: Ok<null> | Err
  AGENT_PROFILE_TRANSFER_CHUNK: Ok<null> | Err
  AGENT_PROFILE_TRANSFER_COMPLETE: Ok<null> | Err
  AGENT_PROFILE_TRANSFER_ACK: Ok<{ status?: AgentCaptureStatusPayload; error?: AgentBridgeError }> | Err
}

export type ResponseFor<T extends MessageType> = ResponsePayloadMap[T]
