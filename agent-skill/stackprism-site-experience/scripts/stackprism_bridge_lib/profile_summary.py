import re

from .protocol import redact_url

MAX_TEXT = 120
MAX_ITEMS = 6
TOKEN_TEXT = re.compile(r"\b(apiToken|bridgeToken|authorization|cookie|nonce|secret|token)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+", re.I)
ID_TEXT = re.compile(r"\b(?:spbt?_|cap_|s_|n_|xfer_|shot_)[A-Za-z0-9_-]{8,}\b")
EMAIL_TEXT = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE_TEXT = re.compile(r"\b(?:\+?\d[\d -]{8,}\d)\b")
URL_TEXT = re.compile(r"https?://[^\s\"')\]}]+")


def is_record(value):
    return isinstance(value, dict)


def safe_text(value, max_len=MAX_TEXT):
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    text = URL_TEXT.sub(lambda match: redact_url(match.group(0)) or "[redacted-url]", text)
    text = TOKEN_TEXT.sub(lambda match: f"{match.group(1)}=[redacted]", text)
    text = ID_TEXT.sub("[redacted-id]", text)
    text = EMAIL_TEXT.sub("[redacted-email]", text)
    text = PHONE_TEXT.sub("[redacted-number]", text)
    return text[:max_len]


def values(value, limit=MAX_ITEMS):
    source = value if isinstance(value, list) else [value] if isinstance(value, str) else []
    result = []
    for item in source:
        text = safe_text(item)
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def object_values(items, keys=("name", "type", "category", "domain", "label"), limit=MAX_ITEMS):
    if not isinstance(items, list):
        return []
    result = []
    for item in items:
        if is_record(item):
            text = next((safe_text(item.get(key)) for key in keys if safe_text(item.get(key))), "")
        else:
            text = safe_text(item)
        if text:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def count(value):
    return len(value) if isinstance(value, (list, dict)) else 0


def add(items, label, value):
    text = safe_text(value)
    if text:
        items.append(f"{label}: {text}")


def add_list(items, label, value, limit=MAX_ITEMS):
    text_values = values(value, limit)
    if text_values:
        items.append(f"{label}: {', '.join(text_values)}")


def add_object_list(items, label, value, limit=MAX_ITEMS):
    text_values = object_values(value, limit=limit)
    if text_values:
        items.append(f"{label}: {', '.join(text_values)}")


def card(card_id, title, items):
    return {"id": card_id, "title": title, "items": items} if items else None


def nested(record, *keys):
    value = record
    for key in keys:
        value = value.get(key) if is_record(value) else None
    return value if is_record(value) else {}


def target_card(profile, capture, screenshot):
    target = profile.get("target") if is_record(profile.get("target")) else {}
    items = []
    add(items, "目标 URL", capture.get("finalUrl") or (capture.get("request") or {}).get("url") or target.get("finalUrl") or target.get("url"))
    add(items, "页面语言", target.get("language"))
    add(items, "生成时间", profile.get("generatedAt"))
    items.append(f"截图: {'已包含' if screenshot else '未包含'}")
    return card("target", "目标", items)


def tech_card(profile):
    tech = profile.get("techProfile") if is_record(profile.get("techProfile")) else {}
    technologies = tech.get("technologies") if isinstance(tech.get("technologies"), list) else []
    items = []
    if technologies:
        items.append(f"技术数量: {len(technologies)}")
    add_object_list(items, "主要技术", technologies)
    add(items, "前端主栈", tech.get("primaryFrontend"))
    add(items, "UI 框架", tech.get("uiFramework"))
    add(items, "构建运行时", tech.get("buildRuntime"))
    add_list(items, "第三方服务", tech.get("thirdPartyServices"))
    return card("tech", "技术栈", items)


def visual_card(profile, screenshot):
    visual = profile.get("visualProfile") if is_record(profile.get("visualProfile")) else {}
    tokens = nested(profile, "agentGuidance", "recreationPlan", "designTokens")
    ref = nested(profile, "agentGuidance", "recreationPlan", "visualReference")
    items = [f"截图: {'可用于视觉对照' if screenshot else '未包含'}"]
    add_list(items, "颜色", visual.get("colorTokens") or tokens.get("colors"))
    add_list(items, "字体", visual.get("fonts") or tokens.get("fontFamilies"))
    add_list(items, "字号", visual.get("fontSizes") or tokens.get("fontSizes"))
    add(items, "截图范围", ref.get("screenshotScope"))
    return card("visual", "视觉", items)


def layout_card(profile):
    layout = profile.get("layoutProfile") if is_record(profile.get("layoutProfile")) else {}
    ux = profile.get("uxProfile") if is_record(profile.get("uxProfile")) else {}
    blueprint = nested(profile, "agentGuidance", "recreationPlan", "layoutBlueprint")
    items = []
    add(items, "页面目的", ux.get("pagePurpose"))
    add_list(items, "主要路径", ux.get("primaryUserPath"))
    add_list(items, "信息层级", ux.get("informationHierarchy") or blueprint.get("informationHierarchy"))
    add_list(items, "内容分组", ux.get("contentGrouping") or blueprint.get("contentGrouping"))
    add_list(items, "Landmarks", layout.get("landmarks") or blueprint.get("landmarks"))
    add(items, "导航深度", ux.get("navigationDepth"))
    return card("layout", "布局与信息结构", items)


def components_card(profile):
    components = profile.get("componentProfile") if is_record(profile.get("componentProfile")) else {}
    inventory = nested(profile, "agentGuidance", "recreationPlan", "componentInventory")
    counts = components.get("counts") if is_record(components.get("counts")) else inventory.get("counts")
    items = []
    if count(counts):
        items.append(f"组件类型数: {count(counts)}")
    add_list(items, "优先组件", inventory.get("priorityTypes"))
    add_object_list(items, "组件样本", components.get("samples"))
    add(items, "几何信息", "已包含" if inventory.get("geometryIncluded") is True else "未包含" if inventory.get("geometryIncluded") is False else "")
    return card("components", "组件", items)


def interaction_card(profile):
    interaction = profile.get("interactionProfile") if is_record(profile.get("interactionProfile")) else {}
    ux = profile.get("uxProfile") if is_record(profile.get("uxProfile")) else {}
    checklist = nested(profile, "agentGuidance", "recreationPlan", "interactionChecklist")
    items = []
    add_list(items, "CTA", ux.get("ctaStrategy"))
    add_list(items, "信任信号", ux.get("trustSignals"))
    add_list(items, "转场", interaction.get("transitions") or checklist.get("transitions"))
    add_list(items, "动画", interaction.get("animations") or checklist.get("animations"))
    add_list(items, "固定元素", interaction.get("stickyOrFixed") or checklist.get("stickyOrFixed"))
    add_list(items, "交互摩擦", ux.get("frictionPoints"))
    return card("interaction", "交互与 UX", items)


def assets_card(profile):
    assets = profile.get("assetProfile") if is_record(profile.get("assetProfile")) else {}
    hints = nested(profile, "agentGuidance", "recreationPlan", "assetHints")
    items = []
    if count(assets.get("scripts")) or hints.get("scriptCount"):
        items.append(f"脚本: {count(assets.get('scripts')) or hints.get('scriptCount')}")
    if count(assets.get("stylesheets")) or hints.get("stylesheetCount"):
        items.append(f"样式表: {count(assets.get('stylesheets')) or hints.get('stylesheetCount')}")
    add_list(items, "资源域名", hints.get("resourceDomains") or assets.get("resourceDomains"))
    add_list(items, "CDN 线索", assets.get("cdnHints") or hints.get("cdnHints"))
    add_list(items, "字体资源", assets.get("fontUrls") or hints.get("fontUrls"))
    return card("assets", "资产", items)


def guidance_card(profile):
    guidance = profile.get("agentGuidance") if is_record(profile.get("agentGuidance")) else {}
    plan = guidance.get("recreationPlan") if is_record(guidance.get("recreationPlan")) else {}
    items = []
    add(items, "摘要", guidance.get("summary"))
    add_list(items, "实现顺序", plan.get("implementationOrder"), 4)
    add_list(items, "验证项", plan.get("verificationChecklist"), 4)
    add_list(items, "限制", profile.get("limitations"), 4)
    return card("guidance", "复刻建议", items)


def copy_text_for(cards):
    lines = ["# StackPrism Site Experience", "", "用于 AI Agent 快速复刻目标网站体验的受限摘要。"]
    for item in cards:
        lines.extend(["", f"## {item['title']}"])
        lines.extend([f"- {entry}" for entry in item["items"]])
    lines.extend(["", "备注: 本摘要不包含 raw profile、token、nonce、截图 data URL 或完整敏感文本。"])
    return "\n".join(lines)


def profile_preview_summary(capture, screenshot):
    profile = capture.get("profile")
    if capture.get("status") != "completed" or not is_record(profile):
        return None
    cards = [item for item in [
        guidance_card(profile), visual_card(profile, screenshot), layout_card(profile),
        components_card(profile), interaction_card(profile), tech_card(profile), assets_card(profile),
        target_card(profile, capture, screenshot)
    ] if item]
    return {"contentSummary": {"cards": cards}, "copyText": copy_text_for(cards)} if cards else None
