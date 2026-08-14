window.__ModuleLoader__.load({
	id: "dsh-llm-codex-auth-native-compact-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var SECTION_ID = "codex-oauth";
async function responseJson(response) {
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return payload;
}
function percentText(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function windowLabel(window, fallback) {
  const seconds = window?.windowSeconds;
  if (typeof seconds !== "number") return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400} \u5929\u7A97\u53E3`;
  if (seconds % 3600 === 0) return `${seconds / 3600} \u5C0F\u65F6\u7A97\u53E3`;
  return fallback;
}
function resetText(resetAt) {
  return typeof resetAt === "number" ? `\u91CD\u7F6E\uFF1A${new Date(resetAt * 1e3).toLocaleString()}` : "\u91CD\u7F6E\u65F6\u95F4\u672A\u77E5";
}
function UsageWindow({ title, window }) {
  if (window === void 0) return null;
  const remaining = Math.min(100, Math.max(0, window.remainingPercent));
  const color = remaining > 50 ? "#22c55e" : remaining > 20 ? "#f59e0b" : "#ef4444";
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "4px" } },
    (0, import_react.createElement)(
      "div",
      { style: { display: "flex", justifyContent: "space-between", gap: "12px" } },
      (0, import_react.createElement)("span", null, windowLabel(window, title)),
      (0, import_react.createElement)("strong", null, `\u5269\u4F59 ${percentText(remaining)}%`)
    ),
    (0, import_react.createElement)("div", {
      role: "progressbar",
      "aria-label": `${title}\u5269\u4F59\u7528\u91CF`,
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": remaining,
      style: { height: "8px", overflow: "hidden", borderRadius: "999px", background: "rgba(127, 127, 127, 0.25)" }
    }, (0, import_react.createElement)("div", {
      style: { width: `${remaining}%`, height: "100%", borderRadius: "inherit", background: color, transition: "width 160ms ease" }
    })),
    (0, import_react.createElement)("small", { style: { opacity: 0.72 } }, resetText(window.resetAt))
  );
}
function CodexSection() {
  const [data, setData] = (0, import_react.useState)(null);
  const [usage, setUsage] = (0, import_react.useState)(null);
  const [usageLoading, setUsageLoading] = (0, import_react.useState)(false);
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      setData(await responseJson(await fetch("/codex-oauth/status")));
    } catch (error) {
      setData({ ok: false, statusText: error instanceof Error ? error.message : String(error) });
    }
  }, []);
  const refreshUsage = (0, import_react.useCallback)(async (force = false) => {
    setUsageLoading(true);
    try {
      const suffix = force ? "?refresh=1" : "";
      setUsage(await responseJson(await fetch(`/codex-oauth/usage${suffix}`)));
    } catch (error) {
      setUsage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setUsageLoading(false);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    refresh();
    const timer = setInterval(refresh, 3e3);
    return () => clearInterval(timer);
  }, [refresh]);
  const connected = data?.connected === true;
  (0, import_react.useEffect)(() => {
    if (!connected) {
      setUsage(null);
      return void 0;
    }
    refreshUsage();
    const timer = setInterval(refreshUsage, 6e4);
    return () => clearInterval(timer);
  }, [connected, refreshUsage]);
  const act = (0, import_react.useCallback)(async (operation) => {
    try {
      await responseJson(await fetch(`/codex-oauth/${operation}`, { method: "POST" }));
    } catch {
    }
    await refresh();
  }, [refresh]);
  const statusText = data?.statusText ?? "\u52A0\u8F7D\u4E2D\u2026";
  const pending = !connected && data?.verificationUrl;
  return (0, import_react.createElement)(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    pending ? (0, import_react.createElement)(
      "p",
      null,
      "\u8BF7\u6253\u5F00 ",
      (0, import_react.createElement)("a", { href: data.verificationUrl, target: "_blank", rel: "noreferrer" }, data.verificationUrl),
      "\uFF0C\u8F93\u5165\u8BBE\u5907\u7801 ",
      (0, import_react.createElement)("b", null, data.userCode)
    ) : (0, import_react.createElement)("p", null, statusText),
    connected ? (0, import_react.createElement)("button", { type: "button", onClick: () => act("logout") }, "\u767B\u51FA") : (0, import_react.createElement)("button", { type: "button", onClick: () => act("login") }, "\u767B\u5F55 ChatGPT \u8D26\u53F7"),
    connected && data?.expiresAt ? (0, import_react.createElement)("p", null, "access token \u5230\u671F\uFF1A", new Date(data.expiresAt).toLocaleString()) : null,
    connected ? (0, import_react.createElement)(
      "section",
      { style: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" } },
      (0, import_react.createElement)(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" } },
        (0, import_react.createElement)("strong", null, `\u8BA2\u9605\u7528\u91CF${usage?.planType ? `\uFF08${usage.planType}\uFF09` : ""}`),
        (0, import_react.createElement)("button", {
          type: "button",
          disabled: usageLoading,
          onClick: () => refreshUsage(true)
        }, usageLoading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0\u7528\u91CF")
      ),
      usage === null ? (0, import_react.createElement)("p", null, "\u6B63\u5728\u52A0\u8F7D\u8BA2\u9605\u7528\u91CF\u2026") : usage.ok === false ? (0, import_react.createElement)("p", { style: { color: "#ef4444" } }, `\u7528\u91CF\u67E5\u8BE2\u5931\u8D25\uFF1A${usage.error}`) : (0, import_react.createElement)(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        (0, import_react.createElement)(UsageWindow, { title: "\u77ED\u5468\u671F", window: usage.primary }),
        (0, import_react.createElement)(UsageWindow, { title: "\u957F\u5468\u671F", window: usage.secondary }),
        usage.updatedAt ? (0, import_react.createElement)("small", { style: { opacity: 0.72 } }, `\u66F4\u65B0\u65F6\u95F4\uFF1A${new Date(usage.updatedAt).toLocaleString()}`) : null
      )
    ) : null
  );
}
var name = "dsh-llm-codex-auth-native-compact-image";
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: SECTION_ID,
    order: 100,
    label: "Codex \u8BA2\u9605 (ChatGPT)"
  }, CodexSection));
}

		return module.exports;
	}
});
