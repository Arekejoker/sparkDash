import { ZH } from "./zh";

const LANG_KEY = "sparkdash-lang";
const ATTRS = ["placeholder", "title", "aria-label", "aria-description", "aria-placeholder", "alt", "data-tooltip"];
const CJK = /[\u4e00-\u9fff]/;

function storedLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) || "zh";
  } catch {
    return "zh";
  }
}

function setLang(lang: string) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* ignore */
  }
}

function isSkippedText(el: Element | null): boolean {
  if (!el) return true;
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "PRE" || tag === "TEXTAREA") return true;
  if (el.closest("[data-no-i18n], .terminal, .xterm, .cm-editor, .log, .logs, .code")) return true;
  return (el as HTMLElement).isContentEditable === true;
}

function isSkippedAttr(el: Element): boolean {
  return !!el.closest("[data-no-i18n], .terminal, .xterm, .cm-editor, pre");
}

const WEEKDAY: Record<string, string> = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
const MONTH: Record<string, string> = { Jan: "1月", Feb: "2月", Mar: "3月", Apr: "4月", May: "5月", Jun: "6月", Jul: "7月", Aug: "8月", Sep: "9月", Oct: "10月", Nov: "11月", Dec: "12月" };
const LONG_MONTH: Record<string, string> = { January: "1月", February: "2月", March: "3月", April: "4月", May: "5月", June: "6月", July: "7月", August: "8月", September: "9月", October: "10月", November: "11月", December: "12月" };

function patterns(s: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d[\d,.]*)\s+Sparks?$/i))) return `${m[1]} 台 Spark`;
  if ((m = s.match(/^\/\s*(\d[\d,.]*)\s+units?$/i))) return `/ ${m[1]} 个节点`;
  if ((m = s.match(/^Estimated, not wall-metered\s+·\s+(.+?)\s+coverage\s+(.+)$/i))) return `估算值，非电表实测 · ${m[1]} 覆盖率 ${m[2]}`;
  if ((m = s.match(/^No model\s+·\s+worker of\s+(.+)$/i))) return `未加载模型 · ${m[1]} 的工作节点`;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?\s+ago$/i))) return `${m[1]} 小时前`;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/i))) return `${m[1]} 小时`;
  if ((m = s.match(/^(\d+)\s*d(?:ays?)?$/i))) return `${m[1]} 天`;
  if (/^now$/i.test(s)) return "现在";
  if ((m = s.match(/^(\d+)d\s+(\d+)h$/i))) return `${m[1]} 天 ${m[2]} 小时`;
  if ((m = s.match(/^(\d+)\s+min$/i))) return `${m[1]} 分钟`;
  if ((m = s.match(/^Unified memory\s+(\d+)%\s+used$/i))) return `统一内存已用 ${m[1]}%`;
  if ((m = s.match(/^System\s+(.+)$/i))) return `系统 ${m[1]}`;
  if ((m = s.match(/^Free\s+(.+)$/i))) return `可用 ${m[1]}`;
  if ((m = s.match(/^switch to\s+(.+)$/i))) return `切换到 ${m[1]}`;
  if ((m = s.match(/^(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)\s+fresh$/i))) return `${m[1]}/${m[2]} 最新`;
  if ((m = s.match(/^(\d[\d,.]*)\s*\/\s*(\d[\d,.]*)\s+units?$/i))) return `${m[1]}/${m[2]} 个节点`;
  if ((m = s.match(/^(.+?)\s+VRAM in use\s+·\s+GPU\s+(.+)$/i))) return `${m[1]} 显存占用 · GPU ${m[2]}`;
  if ((m = s.match(/^(\d[\d,.]*)\s+online$/i))) return `${m[1]} 在线`;
  if ((m = s.match(/^(\d[\d,.]*)\s+offline$/i))) return `${m[1]} 离线`;
  if ((m = s.match(/^(\d[\d,.]*)\s+models?$/i))) return `${m[1]} 个模型`;
  if ((m = s.match(/^(\d[\d,.]*)\s+active$/i))) return `${m[1]} 活跃`;
  if ((m = s.match(/^(\d[\d,.]*)\s+tokens?$/i))) return `${m[1]} Token`;
  if ((m = s.match(/^(\d[\d,.]*)\s+requests?$/i))) return `${m[1]} 个请求`;
  if ((m = s.match(/^(\d[\d,.]*)\s+runs?$/i))) return `${m[1]} 次运行`;
  if ((m = s.match(/^(\d[\d,.]*)\s+items?$/i))) return `${m[1]} 项`;
  if ((m = s.match(/^(\d[\d,.]*)\s+files?$/i))) return `${m[1]} 个文件`;
  if ((m = s.match(/^(\d[\d,.]*)\s+minutes?$/i))) return `${m[1]} 分钟`;
  if ((m = s.match(/^(\d[\d,.]*)\s+hours?$/i))) return `${m[1]} 小时`;
  if ((m = s.match(/^(\d[\d,.]*)\s+days?$/i))) return `${m[1]} 天`;
  if ((m = s.match(/^(\d[\d,.]*)\s+seconds?$/i))) return `${m[1]} 秒`;
  if ((m = s.match(/^Updated\s+(.+)$/i))) return `更新于 ${m[1]}`;
  if ((m = s.match(/^Model:\s*(.+)$/i))) return `模型：${m[1]}`;
  if ((m = s.match(/^up\s+(.+)$/i))) return `已运行 ${m[1]}`;
  if ((m = s.match(/^Port\s+(\d+)$/i))) return `端口 ${m[1]}`;
  if ((m = s.match(/^(.+?)\s+of\s+(.+?)\s+used\s+\((.+?)\)$/i))) return `${m[1]} / ${m[2]} 已用（${m[3]}）`;
  if ((m = s.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+):\s+(\d+)\s+events$/))) return `${WEEKDAY[m[1]]}，${MONTH[m[2]]}${m[3]}日：${m[4]} 个事件`;
  if ((m = s.match(/^Events per day over the last\s+(\d+)\s+days?,?\s*(\d+)\s+in total$/i))) return `近 ${m[1]} 天每日事件，总计 ${m[2]} 个`;
  if ((m = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\s+summary$/i))) return `${m[2]} 年 ${LONG_MONTH[m[1]]}汇总`;
  if ((m = s.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{2}:\d{2}):\s*(.*)$/))) return `${WEEKDAY[m[1]]} ${m[2]}：${m[3].toLowerCase() === "no data" ? "无数据" : m[3]}`;
  if ((m = s.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{2}:\d{2})\s+local$/i))) return `${WEEKDAY[m[1]]} ${m[2]} 本地`;
  if ((m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i))) { const h = parseInt(m[1],10) % 12; const hh = m[3].toUpperCase() === "PM" ? h + 12 : h; return `${String(hh).padStart(2,"0")}:${m[2]}`; }
  if ((m = s.match(/^now\s+(.+)$/i))) return `当前 ${m[1]}`;
  if ((m = s.match(/^(\d+)\s+in\s+(\d+)\s+d$/i))) return `${m[1]} 个 / ${m[2]} 天`;
  if ((m = s.match(/^(\d+)\s+s$/))) return `${m[1]} 秒`;
  if ((m = s.match(/^(\d+)\s+h covered$/i))) return `${m[1]} 小时覆盖`;
  if ((m = s.match(/^No reachable LLM on port\s+(\d+)$/i))) return `端口 ${m[1]} 上没有可用的 LLM`;
  if ((m = s.match(/^(.+?) uses the most energy: (.+?), (\d+)% of the fleet total, averaging (.+?) while reporting\. That is ([\d.]+)x the next node\.$/))) return `${m[1]} 能耗最高：${m[2]}，占集群总能耗的 ${m[3]}%，上报期间平均 ${m[4]}。是第二名节点的 ${m[5]} 倍。`;
  if ((m = s.match(/^The highest-draw hour was (.+?) at (.+?); the lowest was (.+?) at (.+?)\.$/))) return `功率最高的时段是 ${m[1]}，为 ${m[2]}；最低的是 ${m[3]}，为 ${m[4]}。`;
  if ((m = s.match(/^(\d+) scenarios · about (.+)$/i))) return `${m[1]} 个场景 · 约 ${m[2]}`;
  if ((m = s.match(/^(\d+) events?$/i))) return `${m[1]} 个事件`;
  return null;
}

function mixed(s: string): string | null {
  if (/^up\s+/i.test(s)) return s.replace(/^up\s+/i, "已运行 ");
  if (/^last:\s*/i.test(s)) return s.replace(/^last:\s*/i, "上次：");
  if (/^embedding:\s*/i.test(s)) return s.replace(/^embedding:\s*/i, "嵌入：");
  if (/^\(desired:\s*/i.test(s)) return s.replace(/^\(desired:\s*/i, "（期望：");
  return null;
}

function lookup(s: string): string | null {
  if (!s) return null;
  const mixedHit = mixed(s);
  if (mixedHit) return mixedHit;
  if (CJK.test(s)) return null;
  const direct = ZH[s];
  if (direct) return direct;
  if (s.endsWith(":")) {
    const base = ZH[s.slice(0, -1)];
    if (base) return `${base}：`;
  }
  const colon = s.indexOf(": ");
  if (colon > 0) {
    const base = ZH[s.slice(0, colon)];
    if (base) return `${base}：${s.slice(colon + 2)}`;
  }
  const bullet = s.match(/^([•·]\s*)/);
  if (bullet) {
    const rest = s.slice(bullet[1].length);
    const hit = ZH[rest] ?? patterns(rest);
    if (hit) return bullet[1] + hit;
  }
  return patterns(s);
}

function translate(raw: string): string {
  const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m) return raw;
  const core = m[2].replace(/\s+/g, " ").trim();
  if (!core) return raw;
  const hit = lookup(core);
  if (!hit || hit === core) return raw;
  return m[1] + hit + m[3];
}

function translateText(node: Text) {
  if (isSkippedText(node.parentElement)) return;
  if (node.nodeValue === "s") {
    const prev = node.previousSibling;
    const before = prev?.previousSibling;
    if (prev?.nodeType === Node.TEXT_NODE && before?.nodeType === Node.TEXT_NODE && /^\s*Spark$/.test(prev.nodeValue || "") && /^\s*\d[\d,.]*\s*$/.test(before.nodeValue || "")) {
      prev.nodeValue = " 台 Spark";
      node.nodeValue = "";
      return;
    }
  }
  const raw = node.nodeValue;
  if (!raw) return;
  if (/^\s*up\s*$/i.test(raw) && /[天小时分钟秒]/.test(node.parentElement?.textContent || "")) {
    node.nodeValue = "已运行 ";
    return;
  }
  const next = translate(raw);
  if (next === raw) return;
  if (next.trim() === "模型") {
    let ctx = "";
    let p = node.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) ctx += p.textContent || "";
    if (/GB10|20 核|cores?/.test(ctx)) {
      node.nodeValue = next.replace("模型", "型号");
      return;
    }
  }
  node.nodeValue = next;
}

function translateAttrs(el: Element) {
  if (isSkippedAttr(el)) return;
  for (const attr of ATTRS) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const next = translate(value);
    if (next !== value) el.setAttribute(attr, next);
  }
}

function scan(root: Node) {
  if (!root.isConnected) return;
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (isSkippedText(el)) return;
  translateAttrs(el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) translateAttrs(node as Element);
    else translateText(node as Text);
  }
}

const pending = new Set<Node>();
let scheduled = false;

function flush() {
  scheduled = false;
  for (const node of pending) scan(node);
  pending.clear();
  translateTitle();
}

function schedule(node: Node) {
  pending.add(node);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(flush);
}

function translateTitle() {
  const m = document.title.match(/^sparkDash\s*[—–-]\s*(.+)$/);
  if (!m) return;
  const sub = lookup(m[1]);
  if (sub && sub !== m[1]) document.title = `sparkDash — ${sub}`;
}

function addFont() {
  if (document.getElementById("sparkdash-zh-font")) return;
  const style = document.createElement("style");
  style.id = "sparkdash-zh-font";
  style.textContent = 'html[lang="zh-CN"] body,html[lang="zh-CN"] button,html[lang="zh-CN"] input,html[lang="zh-CN"] select,html[lang="zh-CN"] textarea{font-family:"Geist Variable","PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif}';
  document.head.appendChild(style);
}

function addToggle() {
  if (document.getElementById("sparkdash-lang-toggle")) return;
  const zh = storedLang() !== "en";
  const btn = document.createElement("button");
  btn.id = "sparkdash-lang-toggle";
  btn.type = "button";
  btn.setAttribute("data-no-i18n", "");
  btn.textContent = zh ? "EN" : "中文";
  btn.title = zh ? "Switch to English" : "切换到中文";
  btn.setAttribute("aria-label", btn.title);
  Object.assign(btn.style, {
    position: "fixed",
    right: "14px",
    bottom: "14px",
    zIndex: "2147483647",
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(127,127,127,.35)",
    background: "rgba(28,28,30,.72)",
    color: "#fff",
    font: "500 12px/1.2 system-ui, sans-serif",
    cursor: "pointer",
    opacity: ".85",
    backdropFilter: "blur(8px)",
  });
  btn.addEventListener("click", () => {
    setLang(zh ? "en" : "zh");
    location.reload();
  });
  document.body.appendChild(btn);
}

function start() {
  const zh = storedLang() !== "en";
  document.documentElement.lang = zh ? "zh-CN" : "en";
  addToggle();
  if (!zh) return;
  addFont();
  scan(document.documentElement);
  translateTitle();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach(schedule);
      } else {
        schedule(mutation.target);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
