/**
 * conversation.js — mobile chat client for the portfolio (portfolio-ai,
 * mobile-first aesthetic pass).
 *
 * This is a SELF-CONTAINED plain ES module served as a static asset from
 * /scripts/conversation.js. It deliberately has NO imports: the site's Astro
 * script-bundling pipeline is bypassed on purpose (known broken in this
 * environment; owner records it), so everything must be resolved here.
 *
 * Hook contract (single root element, no external dependencies):
 *   root = document.getElementById("conversacion")
 *   query classes under root:
 *     .ask-form          the <form>; submit triggers a question
 *     .ask-input         text input (Enter submits natively)
 *     .ask-button        icon-only submit button (the → arrow)
 *     .ask-thread        role="log" region where turns are appended/scrolled
 *     .ask-thinking      hidden thinking row shown while a request is in flight
 *     .ask-error         hidden error row; its content is built here
 *
 * The .ask-suggestions widget is built and inserted by this module, after the
 * intro turn once the greeting finishes streaming. The server-rendered copy
 * (no-JS/SEO resilience) lives in the thread and is removed at init.
 *
 * Worker base URL — single source: the component renders a tiny inline script
 * that assigns window.__PORTFOLIO_WORKER_URL (from the URL interpolated on a
 * regular element attribute, since script-text interpolation is unavailable in
 * this build). Fallback keeps local development working.
 *
 * Security: model and user output are untrusted. Turns are assembled with
 * createElement/textContent only — never innerHTML.
 */
(function () {
  "use strict";

  var HOOK_ROOT_ID = "conversacion";
  var WORKER_URL_FALLBACK = "http://localhost:8787";
  var MAX_CONTEXT_MESSAGES = 8;
  var REQUEST_TIMEOUT_MS = 25_000;
  /** Display cap for widget labels: longer names are elided with “…” (full text stays in the title). */
  var MAX_WIDGET_LABEL_CHARS = 20;

  /**
   * R1 — conversation persistence across page navigations.
   *
   * The site is static (Astro): navigating to /sobre-mi is a full page load
   * and module state dies with it. The thread is persisted to sessionStorage
   * (per-tab, cleared when the tab closes): the messages array (assistant
   * entries carrying the `widgets` descriptors that ride along with the
   * reply), plus the thread's scroll ratio so a restored conversation lands
   * where it was left. Storage shape:
   *   { v: 1, messages: [{ role, content, widgets? }], scrollRatio: number }
   *
   * Save points: after every completed user-visible turn (the user message
   * is saved right after it is appended, so it survives even when the
   * request never answers; the assistant message is saved once its turn has
   * finished mounting) and on `pagehide` (covers navigation, reload and
   * back/forward). Every sessionStorage access is try/caught: quota or
   * private-mode failures degrade to a silent no-op and the chat keeps
   * working in-memory.
   */
  var STORAGE_KEY = "portfolio-chat-state-v1";
  /** Restore cap: only the last 30 messages are kept on load/save. */
  var MAX_STORED_MESSAGES = 30;
  /** Per-message cap for restored widget descriptors (worker caps replies at 4). */
  var MAX_STORED_WIDGETS_PER_MESSAGE = 6;

  /**
   * Normalizes a persisted scroll ratio to a number in [0, 1]: a non-finite
   * value (NaN/Infinity), a negative value and a value above 1 clamp to the
   * nearest valid boundary.
   */
  function clampRatio(ratio) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 0;
    if (ratio < 0) return 0;
    if (ratio > 1) return 1;
    return ratio;
  }

  /**
   * Reads the thread's current scroll position as a ratio of the scrollable
   * range, clamped to [0, 1]. A thread that is not scrollable (scrollHeight
   * <= clientHeight) reads 0; NaN/negative scrollTop guard to 0 as well.
   */
  function currentScrollRatio(thread) {
    var max = thread.scrollHeight - thread.clientHeight;
    if (!(max > 0)) return 0;
    return clampRatio(thread.scrollTop / max);
  }

  /**
   * Validates one persisted message. Returns a normalized entry only when
   * role is user|assistant and content is a non-empty string. Assistant
   * entries keep a sanitized `widgets` array: plain objects with a numeric
   * index and a non-empty string type, capped at
   * MAX_STORED_WIDGETS_PER_MESSAGE per message (other fields of a kept
   * entry pass through untouched; the renderers re-validate their own
   * inputs). Invalid entries return null and are skipped by loadChatState.
   */
  function sanitizeStoredMessage(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    var role = raw.role;
    var content = raw.content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || content === "") return null;
    if (role !== "assistant") return { role: "user", content: content };

    var widgets = [];
    if (Array.isArray(raw.widgets)) {
      for (
        var i = 0;
        i < raw.widgets.length && widgets.length < MAX_STORED_WIDGETS_PER_MESSAGE;
        i += 1
      ) {
        var widget = raw.widgets[i];
        if (
          typeof widget === "object" &&
          widget !== null &&
          !Array.isArray(widget) &&
          typeof widget.index === "number" &&
          Number.isFinite(widget.index) &&
          typeof widget.type === "string" &&
          widget.type !== ""
        ) {
          widgets.push(widget);
        }
      }
    }
    return { role: "assistant", content: content, widgets: widgets };
  }

  function removeStoredChatState() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Quota/private mode: nothing to clean; silence.
    }
  }

  /**
   * Reads and validates the persisted state. Returns null (removing the
   * stored value) when anything is missing, malformed or unusable: no key,
   * unparseable JSON, wrong shape/v, no messages array, or messages that
   * sanitize to nothing. Valid state is capped to the last
   * MAX_STORED_MESSAGES entries and returned as
   * `{ v: 1, messages, scrollRatio }` (scrollRatio clamped to [0, 1]).
   */
  function loadChatState() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
    if (raw === null) return null;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      removeStoredChatState();
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || parsed.v !== 1) {
      removeStoredChatState();
      return null;
    }

    var messages = [];
    if (Array.isArray(parsed.messages)) {
      var tail = parsed.messages.slice(-MAX_STORED_MESSAGES);
      for (var i = 0; i < tail.length; i += 1) {
        var message = sanitizeStoredMessage(tail[i]);
        if (message) messages.push(message);
      }
    }
    if (messages.length === 0) {
      removeStoredChatState();
      return null;
    }

    return { v: 1, messages: messages, scrollRatio: clampRatio(parsed.scrollRatio) };
  }

  var INTRO_TEXT =
    "Hola, soy Albert Verdú, desarrollador web y diseñador gráfico con más de 20 años de experiencia. ¿En qué puedo ayudarte?";

  var RATE_LIMIT_MESSAGE =
    "Demasiadas preguntas en poco tiempo. Espera un momento y vuelve a intentarlo.";
  var UNAVAILABLE_MESSAGE = "El servicio de respuestas no está disponible ahora mismo.";

  function unavailableError() {
    return { code: "ai_unavailable", message: UNAVAILABLE_MESSAGE, retryable: true };
  }

  /**
   * Reads `{ error: { code, message, retryable } }` from a worker payload.
   * Returns undefined when the body is not usable.
   */
  function readErrorBody(payload) {
    if (typeof payload !== "object" || payload === null) return undefined;
    var error = payload.error;
    if (typeof error !== "object" || error === null) return undefined;
    if (
      typeof error.code !== "string" ||
      error.code === "" ||
      typeof error.message !== "string" ||
      error.message === ""
    ) {
      return undefined;
    }
    return { code: error.code, message: error.message, retryable: error.retryable === true };
  }

  /**
   * Posts the tail of the thread to `{workerUrl}/api/chat`.
   * Always rejects with a plain `{ code, message, retryable }` object; raw
   * exceptions never escape (fetch/network/timeout degrade to ai_unavailable).
   */
  async function postChat(messages, signal) {
    var workerUrl = window.__PORTFOLIO_WORKER_URL ?? WORKER_URL_FALLBACK;

    var response;
    try {
      response = await fetch(workerUrl + "/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ messages: messages.slice(-MAX_CONTEXT_MESSAGES) }),
        signal,
      });
    } catch (error) {
      throw unavailableError();
    }

    var payload;
    try {
      payload = await response.json();
    } catch (error) {
      payload = undefined;
    }

    if (!response.ok) {
      var providerError = readErrorBody(payload);
      if (providerError) {
        // The UI tells rate limiting (429) and scope refusals (422) apart;
        // the HTTP status is authoritative, the body code is preserved on top.
        var statusCode =
          response.status === 429
            ? "rate_limited"
            : response.status === 422
              ? "scope_refused"
              : undefined;
        throw statusCode ? { ...providerError, code: statusCode } : providerError;
      }
      throw unavailableError();
    }

    if (typeof payload !== "object" || payload === null || typeof payload.reply !== "string") {
      throw unavailableError();
    }

    var sources = Array.isArray(payload.sources)
      ? payload.sources.filter(function (source) {
          return typeof source === "string" && source !== "";
        })
      : [];

    // Widgets ride along with the reply (worker normalization, W2). A
    // malformed payload must never throw here: a non-array yields [], and
    // entries that are not plain objects with a numeric `index` and a
    // non-empty string `type` are dropped individually.
    var widgets = [];
    if (Array.isArray(payload.widgets)) {
      widgets = payload.widgets.filter(function (widget) {
        return (
          typeof widget === "object" &&
          widget !== null &&
          !Array.isArray(widget) &&
          typeof widget.index === "number" &&
          Number.isFinite(widget.index) &&
          typeof widget.type === "string" &&
          widget.type !== ""
        );
      });
    }
    return { reply: payload.reply, sources: sources, widgets: widgets };
  }

  function readFailure(error) {
    if (typeof error === "object" && error !== null) {
      var code = error.code;
      var message = error.message;
      if (typeof code === "string" && typeof message === "string") {
        return { code: code, message: message };
      }
    }
    return { code: "ai_unavailable", message: UNAVAILABLE_MESSAGE };
  }

  function messageFor(code, providerMessage) {
    if (code === "rate_limited") return RATE_LIMIT_MESSAGE;
    if (code === "scope_refused") return providerMessage;
    return UNAVAILABLE_MESSAGE;
  }

  function createDot() {
    var dot = document.createElement("span");
    dot.className = "thinking-dot";
    return dot;
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /**
   * Scrolls the thread to its bottom. Smoothness is governed by the CSS
   * scroll-behavior on .ask-thread (auto under prefers-reduced-motion), so a
   * plain scrollTop jump is smooth when allowed and instant otherwise.
   */
  function scrollThreadBottom(thread) {
    thread.scrollTop = thread.scrollHeight;
  }

  /**
   * Types `text` char-by-char into `element` (textContent only), keeping the
   * thread scrolled to the bottom while typing. Fast step (8ms/char) for long
   * replies (>400 chars), slow (16ms/char) otherwise. With
   * prefers-reduced-motion the full text lands instantly.
   */
  function streamText(element, text, thread, done) {
    var reduced = prefersReducedMotion();

    if (reduced) {
      element.textContent = text;
      scrollThreadBottom(thread);
      done();
      return;
    }

    var stepMs = text.length > 400 ? 8 : 16;
    var index = 0;

    function tick() {
      index += 1;
      element.textContent = text.slice(0, index);
      scrollThreadBottom(thread);
      if (index < text.length) {
        window.setTimeout(tick, stepMs);
      } else {
        done();
      }
    }

    tick();
  }

  /**
   * Inline widget engine (client half of the thread-widgets feature, W4).
   *
   * The worker normalizes widget tokens in the model reply into canonical
   * `[[widget:N]]` placeholders plus a parallel `widgets` array. This engine
   * splits the reply on that strict grammar and renders each widget through a
   * per-type registry into the streamed turn.
   *
   * Public API (window.PortfolioWidgets):
   *   PortfolioWidgets.register(type, renderer, options?)
   *     Stores a plain-function renderer under a non-empty string `type`;
   *     returns nothing. `options.block === true` marks the type as a block
   *     widget (see below); the option is optional and defaults to inline.
   *   PortfolioWidgets.isBlockWidget(type)
   *     True when `type` is registered with `{ block: true }`; used by the
   *     streaming logic to decide paragraph closing.
   *   PortfolioWidgets.setLinkMetaResolver(fn)
   *     Internal hook for the link renderer (W5 registers it). Stores a
   *     callable `(url, signal?) => Promise<{ label, iconUrl } | null>`. The
   *     default resolves null, so link placeholders drop visually until W5
   *     installs the real resolver.
   *   PortfolioWidgets.splitReply(reply, widgets)
   *     Splits a reply into ordered text/widget segments (see below).
   *
   * Renderer contract (per type):
   *   renderer(widget, ctx) -> HTMLElement | Promise<HTMLElement | null> | null
   *     `ctx = { resolveLinkMeta }` exposes the current link-meta resolver at
   *     render time. The resolved node must be an HTMLElement to be inserted
   *     in-flow; a null/undefined result, a non-element result, an
   *     unregistered type, or a throwing renderer drops the placeholder and
   *     the surrounding text flows on.
   *
   * Inline vs block widgets. An inline widget (block=false, the default) is
   * appended inside the current `.ask-paragraph` together with the
   * surrounding text. A block widget (registered with `{ block: true }`) is
   * laid out as a flow-level sibling: the current paragraph is closed (and
   * discarded when still empty), the node is appended directly to the
   * `.ask-assistant` turn, and the next text segment opens a fresh paragraph.
   * Text therefore flows above and below the block node with valid HTML. A
   * block placeholder whose renderer drops the node (null) does not close the
   * paragraph, so the surrounding text stays merged.
   *
   * Grammar is strict: only `[[widget:<digits>]]` counts as a placeholder;
   * everything else stays as text. A placeholder index with no matching entry
   * in the `widgets` array is dropped together with its marker, merging the
   * surrounding text.
   *
   * Security: nodes are built with createElement/textContent only, and
   * renderers may only return DOM elements; model output is never interpreted
   * as HTML.
   */
  var widgetRegistry = Object.create(null);
  var defaultLinkMetaResolver = function () {
    return Promise.resolve(null);
  };
  var linkMetaResolver = defaultLinkMetaResolver;

  function register(type, renderer, options) {
    if (typeof type !== "string" || type === "" || typeof renderer !== "function") return;
    widgetRegistry[type] = {
      fn: renderer,
      block: !!(options && options.block),
    };
  }

  /**
   * True when `type` is registered as a block widget. Unknown or inline types
   * return false. Block-ness is a property of the registered type (not of the
   * individual widget entry), so every widget of that type lays out the same
   * way.
   */
  function isBlockWidget(type) {
    if (typeof type !== "string" || type === "") return false;
    var entry = widgetRegistry[type];
    return !!entry && entry.block === true;
  }

  function setLinkMetaResolver(fn) {
    if (typeof fn === "function") linkMetaResolver = fn;
  }

  /**
   * Splits `reply` on canonical `[[widget:<digits>]]` placeholders into
   * `[{ kind: "text", text } | { kind: "widget", widget }]` in reply order.
   * With no widgets the whole reply is a single text segment. A placeholder
   * index with no matching entry in `widgets` is dropped and the surrounding
   * text merges; non-digit variants stay as plain text.
   */
  function splitReply(reply, widgets) {
    if (!Array.isArray(widgets) || widgets.length === 0) {
      return [{ kind: "text", text: reply }];
    }

    var text = typeof reply === "string" ? reply : String(reply);
    var segments = [];
    var cursor = 0;
    var match;
    var markerRe = /\[\[widget:(\d+)\]\]/g;

    // Appends the text between `cursor` and `end`, merging into a preceding
    // text segment so a dropped marker never splits surrounding text.
    function pushText(end) {
      if (cursor >= end) return;
      var piece = text.slice(cursor, end);
      var last = segments[segments.length - 1];
      if (last && last.kind === "text") {
        last.text += piece;
      } else {
        segments.push({ kind: "text", text: piece });
      }
      cursor = end;
    }

    while ((match = markerRe.exec(text)) !== null) {
      pushText(match.index);
      cursor = match.index + match[0].length;
      var widget = findWidgetByIndex(widgets, Number(match[1]));
      if (widget) {
        segments.push({ kind: "widget", widget: widget });
      }
    }
    pushText(text.length);
    return segments;
  }

  function findWidgetByIndex(widgets, index) {
    for (var i = 0; i < widgets.length; i += 1) {
      if (widgets[i].index === index) return widgets[i];
    }
    return null;
  }

  /**
   * Renders a single widget entry to an HTMLElement, or null when the
   * placeholder must be dropped (unregistered type, renderer error, or a
   * result that is not an HTMLElement).
   */
  async function renderWidgetNode(widget) {
    if (typeof widget !== "object" || widget === null) return null;
    var type = widget.type;
    if (typeof type !== "string" || type === "") return null;
    var entry = widgetRegistry[type];
    if (!entry || typeof entry.fn !== "function") return null;

    var node;
    try {
      node = await entry.fn(widget, { resolveLinkMeta: linkMetaResolver });
    } catch (error) {
      return null;
    }
    if (node === null || node === undefined) return null;
    return node instanceof HTMLElement ? node : null;
  }

  /**
   * Elides `text` to at most `max` visible characters, appending “…” when it
   * was cut. Exact character count (not CSS ch approximation). Shared by every
   * widget renderer so label display stays consistent across the thread.
   */
  function truncateLabel(text, max) {
    var safe = String(text ?? "");
    if (safe.length <= max) return safe;
    var cut = max - 1;
    if (cut <= 0) return "…";
    return safe.slice(0, cut) + "…";
  }

  window.PortfolioWidgets = {
    register: register,
    isBlockWidget: isBlockWidget,
    setLinkMetaResolver: setLinkMetaResolver,
    splitReply: splitReply,
    truncateLabel: truncateLabel,
  };

  /**
   * W5 — link widget: worker-backed metadata resolver + renderer.
   *
   * resolveLinkMeta(url) resolves `{ label, iconUrl }` from the worker's
   * `GET /api/link-meta?url=` endpoint. Results are cached in-session per
   * URL: the in-flight promise is stored in the Map, so concurrent calls
   * for the same URL share one fetch. Every failure path (network error,
   * 4s timeout, non-ok status, malformed body) resolves `null`; this
   * function never throws.
   */
  var linkMetaCache = new Map();

  async function resolveLinkMeta(url) {
    try {
      var cached = linkMetaCache.get(url);
      if (cached) return cached;

      // Same worker base URL resolution as postChat.
      var workerUrl = window.__PORTFOLIO_WORKER_URL ?? WORKER_URL_FALLBACK;
      var pending = (async function () {
        try {
          var response = await fetch(
            workerUrl + "/api/link-meta?url=" + encodeURIComponent(url),
            {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(4000),
            }
          );
          if (!response.ok) return null;
          var body = await response.json();
          if (
            typeof body === "object" &&
            body !== null &&
            typeof body.label === "string" &&
            typeof body.iconUrl === "string"
          ) {
            return { label: body.label, iconUrl: body.iconUrl };
          }
          return null;
        } catch (error) {
          return null;
        }
      })();

      linkMetaCache.set(url, pending);
      return pending;
    } catch (error) {
      return null;
    }
  }

  /**
   * Renders a link widget as `<a class="widget-link">` (target _blank,
   * rel noopener noreferrer, title = raw URL) holding a favicon
   * `<img class="widget-link-icon">` and the label in a
   * `<span class="widget-link-label">`. Favicon src and label come from
   * resolved metadata, falling back to the Google favicon service keyed by
   * the URL hostname and the hostname as label. The anchor is built only
   * after metadata resolution (the typewriter pause is the loading state).
   * Nodes are built with createElement/textContent only; any failure
   * returns null and drops the placeholder.
   */
  async function renderLink(widget, ctx) {
    try {
      var url = widget.url;
      if (typeof url !== "string" || url === "") return null;

      var meta = null;
      if (
        typeof ctx === "object" &&
        ctx !== null &&
        typeof ctx.resolveLinkMeta === "function"
      ) {
        try {
          meta = await ctx.resolveLinkMeta(url);
        } catch (error) {
          meta = null;
        }
      }

      // Untrusted input: a malformed URL must not throw here. Fall back to
      // the raw URL's first segment when parsing fails.
      var hostname;
      try {
        hostname = new URL(url).hostname;
      } catch (error) {
        hostname = url.split("/")[0] || url;
      }

      var anchor = document.createElement("a");
      anchor.className = "widget-link";
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.title = url;

      var icon = document.createElement("img");
      icon.className = "widget-link-icon";
      icon.alt = "";
      icon.loading = "lazy";
      icon.referrerPolicy = "no-referrer";
      icon.src =
        (meta && meta.iconUrl) ||
        "https://www.google.com/s2/favicons?domain=" + hostname + "&sz=64";

      var label = document.createElement("span");
      label.className = "widget-link-label";
      var fullLabel = (meta && meta.label) || hostname;
      label.textContent = truncateLabel(fullLabel, MAX_WIDGET_LABEL_CHARS);
      if (label.textContent !== fullLabel) {
        // Truncated: keep the full name reachable (hover + screen reader).
        anchor.title = fullLabel + " — " + url;
        anchor.setAttribute("aria-label", fullLabel);
      }

      anchor.append(icon, label);
      return anchor;
    } catch (error) {
      return null;
    }
  }

  window.PortfolioWidgets.register("link", renderLink);

  /** Client-side cap for image `alt`/`caption` text (worker caps at 200 first). */
  var MAX_WIDGET_IMAGE_TEXT_CHARS = 200;

  /** Character allowlist for site-relative image paths (defense in depth). */
  var SITE_IMAGE_SRC_RE = /^[A-Za-z0-9._~/-]+$/;

  /**
   * True when `raw` is a safe site-relative image path: non-empty, starts with
   * exactly one `/` (never `//`), characters limited to `[A-Za-z0-9._~/-]` (no
   * spaces, no URL-encoded values), and no `..` path segment. Mirrors the
   * worker's `isSiteImagePath` re-asserted client-side for defense in depth.
   */
  function isSafeSiteImagePath(raw) {
    if (typeof raw !== "string" || raw === "") return false;
    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/") return false;
    if (!SITE_IMAGE_SRC_RE.test(raw)) return false;
    return raw.split("/").indexOf("..") === -1;
  }

  /**
   * I4 — image widget renderer.
   *
   * Renders an image widget as `<span class="widget-image">` holding an
   * `<img class="widget-image-img">`. The type is registered as a block
   * widget (P4): the engine closes the current text paragraph before it and
   * opens a fresh one after it, so the wrapper is a real flow-level sibling
   * of the `.ask-paragraph` elements while CSS (I5) keeps the same polaroid
   * look. `src`
   * must be a safe site-relative path and `alt` a non-empty string — anything
   * invalid drops the placeholder (returns null). Nodes are built with
   * createElement/textContent only; no metadata fetch is needed.
   */
  function renderImage(widget, _ctx) {
    if (typeof widget !== "object" || widget === null) return null;
    if (!isSafeSiteImagePath(widget.src)) return null;

    var alt = typeof widget.alt === "string" ? widget.alt.trim() : "";
    if (alt === "") return null;
    alt = alt.slice(0, MAX_WIDGET_IMAGE_TEXT_CHARS);

    var figure = document.createElement("span");
    figure.className = "widget-image";

    var img = document.createElement("img");
    img.className = "widget-image-img";
    img.src = widget.src;
    img.alt = alt;
    img.loading = "lazy";
    img.decoding = "async";
    figure.appendChild(img);

    // Sin pie de foto: estilo polaroid, marco blanco solo en CSS.
    return figure;
  }

  window.PortfolioWidgets.register("image", renderImage, { block: true });

  /**
   * P5 — project card widget: worker-backed project metadata + renderer.
   *
   * resolveProjectMeta(slug) resolves the card data from the worker's
   * `GET /api/project?slug=` endpoint. Results are cached in-session per
   * slug the same way resolveLinkMeta caches by URL: the in-flight promise
   * is stored in the Map, so concurrent calls for the same slug share one
   * fetch. Every failure path (network error, 4s timeout, non-ok status,
   * malformed body) resolves `null`; this function never throws.
   */
  var projectMetaCache = new Map();

  async function resolveProjectMeta(slug) {
    try {
      var cached = projectMetaCache.get(slug);
      if (cached) return cached;

      // Same worker base URL resolution as postChat / resolveLinkMeta.
      var workerUrl = window.__PORTFOLIO_WORKER_URL ?? WORKER_URL_FALLBACK;
      var pending = (async function () {
        try {
          var response = await fetch(workerUrl + "/api/project?slug=" + encodeURIComponent(slug), {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return null;
          var body = await response.json();
          if (
            typeof body === "object" &&
            body !== null &&
            typeof body.title === "string" &&
            typeof body.description === "string"
          ) {
            return {
              slug: typeof body.slug === "string" && body.slug !== "" ? body.slug : slug,
              title: body.title,
              description: body.description,
              url: typeof body.url === "string" && body.url !== "" ? body.url : undefined,
              domain:
                typeof body.domain === "string" && body.domain !== "" ? body.domain : undefined,
              image: typeof body.image === "string" && body.image !== "" ? body.image : undefined,
              siteName:
                typeof body.siteName === "string" && body.siteName !== "" ? body.siteName : undefined,
              iconUrl:
                typeof body.iconUrl === "string" && body.iconUrl !== "" ? body.iconUrl : undefined,
            };
          }
          return null;
        } catch (error) {
          return null;
        }
      })();

      projectMetaCache.set(slug, pending);
      return pending;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extracts the hostname from `url` without throwing; returns "" when the
   * URL does not parse (untrusted input must never break a card render).
   */
  function hostnameFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch (error) {
      return "";
    }
  }

  /**
   * P5 — project card renderer (Telegram-share style, block layout).
   *
   * Builds a card from resolved project metadata: an optional media image,
   * a title/description body, and a footer with favicon + domain label. The
   * outer element is an `<a class="widget-card">` when the project URL is a
   * non-empty http(s) string, otherwise a static
   * `<span class="widget-card widget-card--static">`. Fields absent from the
   * resolved data are omitted (no boxes with empty content); the footer
   * domain falls back `siteName` → `domain` → hostname-from-url, and the
   * favicon falls back to the Google s2 service keyed by hostname. Any
   * unexpected error, a bad slug, or failed metadata resolution returns null
   * and drops the placeholder. Nodes are built with createElement/textContent
   * only — never innerHTML.
   */
  async function renderProject(widget, _ctx) {
    try {
      if (typeof widget !== "object" || widget === null) return null;
      var slug = typeof widget.slug === "string" ? widget.slug : "";
      if (slug === "" || !/^[a-z0-9-]+$/.test(slug)) return null;

      var meta = await resolveProjectMeta(slug);
      if (meta === null) return null;

      var url = meta.url;
      var isHttpUrl =
        typeof url === "string" &&
        (url.slice(0, 8) === "https://" || url.slice(0, 7) === "http://");
      var host = typeof url === "string" ? hostnameFromUrl(url) : "";
      var footerDomain = meta.siteName || meta.domain || host;

      var card;
      if (isHttpUrl) {
        card = document.createElement("a");
        card.className = "widget-card";
        card.href = url;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
      } else {
        card = document.createElement("span");
        card.className = "widget-card widget-card--static";
      }

      // Optional media block: only when a usable absolute image exists.
      var image = meta.image;
      if (
        typeof image === "string" &&
        image !== "" &&
        (image.slice(0, 8) === "https://" || image.slice(0, 7) === "http://")
      ) {
        var media = document.createElement("span");
        media.className = "widget-card-media";

        var mediaImg = document.createElement("img");
        mediaImg.className = "widget-card-image";
        mediaImg.src = image;
        mediaImg.loading = "lazy";
        mediaImg.decoding = "async";
        mediaImg.referrerPolicy = "no-referrer";
        mediaImg.alt = "";
        media.append(mediaImg);

        card.append(media);
      }

      var body = document.createElement("span");
      body.className = "widget-card-body";

      var title = document.createElement("strong");
      title.className = "widget-card-title";
      title.textContent = meta.title;
      body.append(title);

      var description = document.createElement("span");
      description.className = "widget-card-description";
      description.textContent = meta.description;
      body.append(description);

      card.append(body);

      // Footer: favicon (fallback to Google s2 keyed by hostname) + domain.
      if (typeof footerDomain === "string" && footerDomain !== "") {
        var footer = document.createElement("span");
        footer.className = "widget-card-footer";

        var iconDomain = meta.domain || host;
        var iconSrc = "";
        if (typeof meta.iconUrl === "string" && meta.iconUrl !== "") {
          iconSrc = meta.iconUrl;
        } else if (typeof iconDomain === "string" && iconDomain !== "") {
          iconSrc = "https://www.google.com/s2/favicons?domain=" + iconDomain + "&sz=64";
        }
        if (iconSrc !== "") {
          var icon = document.createElement("img");
          icon.className = "widget-card-icon";
          icon.src = iconSrc;
          icon.alt = "";
          icon.loading = "lazy";
          icon.referrerPolicy = "no-referrer";
          footer.append(icon);
        }

        var domainLabel = document.createElement("span");
        domainLabel.className = "widget-card-domain";
        domainLabel.textContent = footerDomain;
        footer.append(domainLabel);

        card.append(footer);
      }

      return card;
    } catch (error) {
      return null;
    }
  }

  window.PortfolioWidgets.register("project", renderProject, { block: true });

  /** Client-side cap for the projects scroller list (worker sorts/caps first). */
  var MAX_PROJECTS_LIST_CAP = 40;
  /** Client-side defensive truncation for scroller card descriptions. */
  var MAX_PROJECT_CARD_DESC_CHARS = 220;

  /**
   * Q2 — projects scroller: worker-backed projects list resolver.
   *
   * resolveProjectsList() resolves the doc-level project list from the
   * worker's `GET /api/projects` endpoint. The result is cached in-session
   * keyed by the request URL: the in-flight promise is stored in the Map, so
   * concurrent and repeated renders share one fetch (same pattern as
   * resolveLinkMeta / resolveProjectMeta). Each item is sanitized
   * ({slug,title} non-empty strings, description string, `url` kept only when
   * a non-empty http(s) string) and the list is capped at 40 items. Every
   * failure path (network error, 4s timeout, non-ok status, malformed body)
   * resolves `null`; this function never throws.
   */
  var projectsListCache = new Map();

  async function resolveProjectsList() {
    try {
      // Same worker base URL resolution as postChat / resolveLinkMeta.
      var workerUrl = window.__PORTFOLIO_WORKER_URL ?? WORKER_URL_FALLBACK;
      var url = workerUrl + "/api/projects";
      var cached = projectsListCache.get(url);
      if (cached) return cached;

      var pending = (async function () {
        try {
          var response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return null;
          var body = await response.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !Array.isArray(body.projects)
          ) {
            return null;
          }

          var raw = body.projects.slice(0, MAX_PROJECTS_LIST_CAP);
          var items = [];
          for (var i = 0; i < raw.length; i += 1) {
            var item = raw[i];
            if (typeof item !== "object" || item === null) continue;
            var slug = typeof item.slug === "string" ? item.slug : "";
            var title = typeof item.title === "string" ? item.title : "";
            if (slug === "" || title === "") continue;
            var urlValue = typeof item.url === "string" ? item.url : "";
            // `var` is function-scoped and reused across iterations: assign
            // both branches explicitly so a url-less item never inherits the
            // previous item's url.
            var safeUrl;
            if (
              urlValue.slice(0, 8) === "https://" ||
              urlValue.slice(0, 7) === "http://"
            ) {
              safeUrl = urlValue;
            } else {
              safeUrl = undefined;
            }
            items.push({
              slug: slug,
              title: title,
              description:
                typeof item.description === "string" ? item.description : "",
              url: safeUrl,
            });
          }
          return items;
        } catch (error) {
          return null;
        }
      })();

      projectsListCache.set(url, pending);
      return pending;
    } catch (error) {
      return null;
    }
  }

  /**
   * Steps the projects scroller by one card slot: the first card's offsetWidth
   * plus the track's computed column gap (parsed as px from getComputedStyle,
   * falling back to 20 when the gap is unavailable or not a positive number).
   * No-op when the scroller has no cards. Used by the desktop-only nav row in
   * renderProjects; smooth-scroll via scrollBy, DOM-only (no innerHTML).
   */
  function scrollProjects(scroller, direction) {
    var card = scroller.querySelector(".projects-card");
    if (card === null) return;
    var gap = 20;
    try {
      var track = scroller.querySelector(".projects-track");
      if (track !== null) {
        var rawGap = parseFloat(getComputedStyle(track).gap);
        if (rawGap > 0) gap = rawGap;
      }
    } catch (error) {
      // Layout API unavailable (stub environment): keep the 20px fallback.
    }
    scroller.scrollBy({
      left: direction * (card.offsetWidth + gap),
      behavior: "smooth",
    });
  }

  /**
   * projects scroller widget renderer (block layout).
   *
   * Renders the ALL-projects horizontal scroller as a single block-level
   * `span.projects-widget` wrapper holding two siblings: the scroller
   * region span (overflow-x auto, flex track of one card per project) and
   * the desktop-only nav row (`span.projects-nav`, ‹/› buttons wired to
   * scrollProjects) OUTSIDE the overflow container, so the buttons never
   * scroll away with the cards. Each card is an anchor to the site's static
   * detail route `/proyectos/<slug>/` (normal navigation — no
   * preventDefault). The card head carries an optional Google-s2 favicon for
   * the project url (hostname via hostnameFromUrl; a url that does not parse
   * to a hostname omits the icon) followed by the serif title, then the
   * description. A null/empty list drops the placeholder.
   * Nodes are built with createElement/textContent only — never innerHTML;
   * any unexpected exception returns null.
   */
  async function renderProjects(widget, _ctx) {
    try {
      if (typeof widget !== "object" || widget === null) return null;
      // The token carries no params; the type check is purely defensive.
      if (widget.type !== "projects") return null;

      var projects = await resolveProjectsList();
      if (projects === null || projects.length === 0) return null;

      var scroller = document.createElement("span");
      scroller.className = "projects-scroller";
      scroller.setAttribute("role", "region");
      scroller.setAttribute("aria-label", "Proyectos en scroll horizontal");
      scroller.setAttribute("tabindex", "0");

      var track = document.createElement("span");
      track.className = "projects-track";

      for (var i = 0; i < projects.length; i += 1) {
        var project = projects[i];

        var card = document.createElement("a");
        card.className = "projects-card";
        card.href = "/proyectos/" + project.slug + "/";

        var head = document.createElement("span");
        head.className = "projects-card-head";

        var host = "";
        if (
          typeof project.url === "string" &&
          (project.url.slice(0, 8) === "https://" ||
            project.url.slice(0, 7) === "http://")
        ) {
          host = hostnameFromUrl(project.url);
        }
        if (host !== "") {
          var icon = document.createElement("img");
          icon.className = "projects-card-icon";
          icon.alt = "";
          icon.loading = "lazy";
          icon.referrerPolicy = "no-referrer";
          icon.src =
            "https://www.google.com/s2/favicons?domain=" +
            encodeURIComponent(host) +
            "&sz=32";
          head.append(icon);
        }

        var title = document.createElement("strong");
        title.className = "projects-card-title";
        title.textContent = project.title;
        head.append(title);

        card.append(head);

        var description = document.createElement("span");
        description.className = "projects-card-desc";
        description.textContent = truncateLabel(
          project.description,
          MAX_PROJECT_CARD_DESC_CHARS
        );
        card.append(description);

        track.append(card);
      }

      scroller.append(track);

      // The nav row is a SIBLING of the scroller inside the block wrapper,
      // never a child of the overflow-x container: appending it to the
      // scroller would make the buttons move with the cards.
      var wrapper = document.createElement("span");
      wrapper.className = "projects-widget";
      wrapper.append(scroller);

      var nav = document.createElement("span");
      nav.className = "projects-nav";
      var prev = document.createElement("button");
      prev.type = "button";
      prev.className = "projects-nav-button";
      prev.setAttribute("aria-label", "Proyectos anteriores");
      prev.textContent = "‹";
      var next = document.createElement("button");
      next.type = "button";
      next.className = "projects-nav-button";
      next.setAttribute("aria-label", "Siguientes proyectos");
      next.textContent = "›";
      nav.append(prev, next);
      wrapper.append(nav);

      prev.addEventListener("click", function () {
        scrollProjects(scroller, -1);
      });
      next.addEventListener("click", function () {
        scrollProjects(scroller, 1);
      });
      return wrapper;
    } catch (error) {
      return null;
    }
  }

  window.PortfolioWidgets.register("projects", renderProjects, { block: true });

  /**
   * Types one text segment into an already-attached Text node (nodeValue
   * only), mirroring streamText's 8ms/16ms stepping and the instant
   * prefers-reduced-motion path. Splitting each segment into its own node
   * lets widget nodes sit between segments in the same paragraph.
   */
  function streamSegment(textNode, text, thread, done) {
    var reduced = prefersReducedMotion();

    if (reduced) {
      textNode.nodeValue = text;
      scrollThreadBottom(thread);
      done();
      return;
    }

    var stepMs = text.length > 400 ? 8 : 16;
    var index = 0;

    function tick() {
      index += 1;
      textNode.nodeValue = text.slice(0, index);
      scrollThreadBottom(thread);
      if (index < text.length) {
        window.setTimeout(tick, stepMs);
      } else {
        done();
      }
    }

    tick();
  }

  /**
   * Shared paragraph lifecycle (P4 block-widget support, R1 restore reuse).
   *
   * Text and inline widget nodes accumulate in one lazily-created
   * `.ask-paragraph`; a block widget closes the current paragraph (discarding
   * it when empty) and lands as a flow-level sibling of the paragraphs; the
   * next text segment opens a fresh paragraph, so text flows above and below
   * the block with valid HTML. A dropped node (null) never closes the
   * paragraph, so the surrounding text stays merged. `close()` also discards
   * a trailing empty paragraph.
   *
   * Both the streaming path (streamSegments) and the instant restore path
   * (mountSegmentsInstant) drive exactly this core, so a restored turn has
   * the identical paragraph/block layout a live streamed one would have.
   */
  function createParagraphLifecycle(turn) {
    var paragraph = null;

    function createParagraph() {
      var p = document.createElement("p");
      p.className = "ask-paragraph";
      turn.append(p);
      return p;
    }

    // Returns the current paragraph, creating it lazily on first use.
    function current() {
      if (!paragraph) paragraph = createParagraph();
      return paragraph;
    }

    // Closes the open paragraph. An empty one is discarded (never leaves a
    // blank <p> before/after a block node or at the end of the turn).
    function close() {
      if (!paragraph) return;
      if (paragraph.childNodes.length === 0) paragraph.remove();
      paragraph = null;
    }

    /**
     * Mounts a rendered widget node at its flow level: block widgets close
     * the current paragraph and append directly to the turn; inline widgets
     * append inside the current paragraph. A null node is dropped without
     * touching the paragraph state.
     */
    function mountWidget(widget, node) {
      if (!node) return;
      if (isBlockWidget(widget.type)) {
        close();
        turn.append(node);
      } else {
        current().append(node);
      }
    }

    return { current: current, close: close, mountWidget: mountWidget };
  }

  /**
   * Streams split segments into `turn` in order, managing the paragraph
   * lifecycle (P4 block-widget support).
   *
   * The current `.ask-paragraph` is created lazily on the first text segment
   * or inline widget: inline nodes and text share one paragraph, exactly as
   * before. A block widget closes the current paragraph (dropping it when it
   * holds no content) and appends its node directly to `turn`; the next text
   * segment then opens a fresh paragraph, so text flows above and below the
   * block with valid HTML. A block placeholder whose node is dropped (null)
   * does not close the paragraph, so the surrounding text stays merged.
   *
   * Text segments type char-by-char into their own Text node; widget segments
   * pause the typewriter, resolve asynchronously via renderWidgetNode and
   * continue. With prefers-reduced-motion the text lands instantly and no
   * timers run; widget nodes still resolve sequentially. A trailing empty
   * paragraph is removed before the promise resolves.
   */
  function streamSegments(turn, segments, thread) {
    return new Promise(function (resolve) {
      var reduced = prefersReducedMotion();
      var lifecycle = createParagraphLifecycle(turn);
      var index = 0;

      function next() {
        if (index >= segments.length) {
          lifecycle.close();
          scrollThreadBottom(thread);
          resolve();
          return;
        }
        var segment = segments[index];
        index += 1;

        if (segment.kind === "text") {
          var target = lifecycle.current();
          var textNode = document.createTextNode("");
          target.append(textNode);
          if (reduced) {
            textNode.nodeValue = segment.text;
            scrollThreadBottom(thread);
            next();
          } else {
            streamSegment(textNode, segment.text, thread, next);
          }
          return;
        }

        // Widget segment: pause typing until the node resolves, then insert.
        renderWidgetNode(segment.widget).then(function (node) {
          lifecycle.mountWidget(segment.widget, node);
          scrollThreadBottom(thread);
          next();
        });
      }

      next();
    });
  }

  /**
   * R1 — mounts split segments into `turn` instantly (no typewriter, no
   * timers), awaiting each widget render in sequence. Pushes segments through
   * the same paragraph lifecycle as streamSegments, so the restored DOM
   * matches what a live streamed turn would have produced: text above and
   * below block widgets, inline widgets inside the paragraph, dropped (null)
   * placeholders merged into the text, no empty paragraphs.
   */
  async function mountSegmentsInstant(turn, segments) {
    var lifecycle = createParagraphLifecycle(turn);

    for (var i = 0; i < segments.length; i += 1) {
      var segment = segments[i];
      if (segment.kind === "text") {
        lifecycle.current().append(document.createTextNode(segment.text));
        continue;
      }
      // Widget: renderers never throw (failures yield null) and the
      // placeholder is dropped with the surrounding text merged.
      var node = await renderWidgetNode(segment.widget);
      lifecycle.mountWidget(segment.widget, node);
    }

    lifecycle.close();
  }

  function init() {
    // W5: install the real link-meta resolver (worker-backed, cached) once,
    // before any reply can render; the module-load default resolves null.
    setLinkMetaResolver(resolveLinkMeta);

    var root = document.getElementById(HOOK_ROOT_ID);
    if (!root) return;

    var form = root.querySelector(".ask-form");
    var input = root.querySelector(".ask-input");
    var submitButton = root.querySelector(".ask-button");
    var thread = root.querySelector(".ask-thread");
    var thinking = root.querySelector(".ask-thinking");
    var errorBox = root.querySelector(".ask-error");

    if (!form || !input || !submitButton || !thread || !thinking || !errorBox) {
      return;
    }

    // The server-rendered suggestions live in the thread and are removed at
    // init; the widget is rebuilt here and inserted after the intro turn.
    var suggestions = [
      { label: "Sobre mí", question: "¿Quién eres y a qué te dedicas?" },
      { label: "Proyectos", question: "¿Qué proyectos has desarrollado?" },
      { label: "Habilidades", question: "¿Qué habilidades tienes?" },
      { label: "Servicios", question: "¿Qué servicios ofreces?" },
      { label: "Contacto", question: "¿Cómo puedo contactar contigo?" },
    ];
    var suggestionsWrap = null;

    var history = [];
    var busy = false;

    /**
     * R1 — persists the thread to sessionStorage ({ v, messages, scrollRatio },
     * see the module-level storage section). Best-effort: quota or private-mode
     * failures degrade to a silent no-op and the chat keeps working in-memory.
     * Called after every completed user-visible turn and on pagehide.
     */
    function saveChatState() {
      try {
        window.sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ v: 1, messages: history, scrollRatio: currentScrollRatio(thread) })
        );
      } catch (error) {
        // Quota/private mode/storage disabled: persistence is best-effort.
      }
    }

    /**
     * Appends an assistant turn and streams its reply into one or more
     * `.ask-paragraph` elements (textContent only), with block widgets as
     * flow-level siblings between paragraphs (P4). Without widgets the
     * previous single-pass streamText behavior is kept unchanged; with widget
     * segments the reply streams per segment, pausing the typewriter while
     * each widget resolves (inline widgets stay in the current paragraph,
     * block widgets close it).
     */
    function buildAssistantTurn(text, widgets) {
      return new Promise(function (resolve) {
        var turn = document.createElement("div");
        turn.className = "ask-assistant";

        thread.append(turn);
        scrollThreadBottom(thread);

        var segments = splitReply(text, widgets);
        var untouchedPlainText =
          segments.length === 1 && segments[0].kind === "text" && segments[0].text === text;

        if (untouchedPlainText) {
          // No widget segments and the text was not altered: the unchanged
          // streamText path (byte-for-byte for the no-widget replies).
          var paragraph = document.createElement("p");
          paragraph.className = "ask-paragraph";
          turn.append(paragraph);
          streamText(paragraph, text, thread, function () {
            scrollThreadBottom(thread);
            resolve();
          });
          return;
        }

        streamSegments(turn, segments, thread).then(resolve);
      });
    }

    function setBusy(value) {
      busy = value;
      input.disabled = value;
      submitButton.disabled = value;
      if (suggestionsWrap) {
        var buttons = suggestionsWrap.querySelectorAll(".ask-suggestion");
        for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = value;
      }
    }

    /**
     * Builds the suggestions widget (buttons with data-question) and wires the
     * click delegation that submits the chosen question. Inserted in-flow after
     * the intro turn, so it scrolls away naturally with the thread.
     */
    function buildSuggestions() {
      var wrap = document.createElement("div");
      wrap.className = "ask-suggestions";
      wrap.setAttribute("role", "group");
      wrap.setAttribute("aria-label", "Sugerencias");

      for (var i = 0; i < suggestions.length; i += 1) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "ask-suggestion";
        button.dataset.question = suggestions[i].question;
        button.textContent = suggestions[i].label;
        wrap.append(button);
      }

      wrap.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;

        var button = target.closest(".ask-suggestion");
        if (!button || busy) return;

        var question = button.dataset.question ?? "";
        if (question === "") return;

        input.value = question;
        void ask(question);
      });

      return wrap;
    }

    function setThinking(value) {
      // Dots only: the row carries no text now. They sit directly inside
      // .ask-thinking so their nth-child stagger applies.
      if (value) {
        if (thinking.querySelectorAll(".thinking-dot").length === 0) {
          thinking.append(createDot(), createDot(), createDot());
        }
        // The indicator lives at the END of the thread (below the last
        // message), so it is (re)moved there and the thread stays pinned
        // to the bottom while it shows.
        thread.append(thinking);
        thinking.hidden = false;
        scrollThreadBottom(thread);
      } else {
        thinking.hidden = true;
      }
    }

    function appendUserTurn(question) {
      var turn = document.createElement("div");
      turn.className = "ask-user";

      var ask = document.createElement("p");
      ask.className = "ask-ask";
      ask.textContent = question;

      turn.append(ask);
      thread.append(turn);
      scrollThreadBottom(thread);
      return turn;
    }

    function showError(code, providerMessage) {
      errorBox.replaceChildren();

      var title = document.createElement("strong");
      title.textContent = "Servicio no disponible";

      var message = document.createElement("p");
      message.className = "ask-error-message";
      message.textContent = messageFor(code, providerMessage);

      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ask-retry";
      retry.textContent = "Reintentar";
      retry.addEventListener("click", function () {
        var last = history[history.length - 1];
        if (!last || last.role !== "user" || busy) return;
        // Resends the last question: it is still the tail of the thread.
        void runRequest();
      });

      errorBox.append(title, message, retry);
      errorBox.hidden = false;
      retry.focus();
    }

    async function runRequest() {
      if (busy) return;

      errorBox.hidden = true;
      setBusy(true);
      setThinking(true);

      var controller = new AbortController();
      var timeout = window.setTimeout(function () {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        var response = await postChat(history, controller.signal);
        // Streaming starts now: drop the thinking indicator before the
        // first character of the reply is typed. The typewriter keeps the
        // thread pinned to the bottom on its own from here on.
        setThinking(false);
        // Assistant entries carry the widget descriptors that ride along
        // with the reply (R1: they are persisted with the message and used
        // to re-render widgets on restore).
        history.push({ role: "assistant", content: response.reply, widgets: response.widgets ?? [] });
        await buildAssistantTurn(response.reply, response.widgets ?? []);
        // Turn fully mounted: the visible state is now durable.
        saveChatState();
      } catch (error) {
        var failure = readFailure(error);
        showError(failure.code, failure.message);
      } finally {
        window.clearTimeout(timeout);
        // Eager hide already ran on success; on failure this is the path
        // that hides the indicator before showing the error (as before).
        setThinking(false);
        setBusy(false);
        input.focus();
      }
    }

    async function ask(question) {
      var trimmed = question.trim();
      if (trimmed === "" || busy) return;

      history.push({ role: "user", content: trimmed });
      appendUserTurn(trimmed);
      // The user message survives even if the request never answers.
      saveChatState();
      input.value = "";
      await runRequest();
    }

    /**
     * Greeting as the first thread message. The server-rendered intro (kept
     * for no-JS/SEO resilience) is removed first, then the same text streams
     * with the typewriter effect. The composer stays locked while it types.
     */
    function streamIntro() {
      // The server-rendered intro + suggestions are no-JS/SEO resilience:
      // drop both and re-stream the greeting through the typewriter.
      thread.replaceChildren();

      var turn = document.createElement("div");
      turn.className = "ask-assistant";

      var paragraph = document.createElement("p");
      paragraph.className = "ask-paragraph ask-paragraph--first";
      turn.append(paragraph);

      thread.append(turn);

      setBusy(true);
      streamText(paragraph, INTRO_TEXT, thread, function () {
        suggestionsWrap = buildSuggestions();
        turn.after(suggestionsWrap);
        scrollThreadBottom(thread);
        setBusy(false);
        input.focus();
      });
    }

    /**
     * R1 — assembles a persisted assistant message as a full `.ask-assistant`
     * turn instantly: paragraphs land complete (no typewriter) and widget
     * placeholders resolve in sequence through the same paragraph lifecycle
     * the live streaming path uses. Returns the turn element.
     */
    async function appendAssistantTurnInstant(message) {
      var turn = document.createElement("div");
      turn.className = "ask-assistant";

      thread.append(turn);
      scrollThreadBottom(thread);

      var widgets = Array.isArray(message.widgets) ? message.widgets : [];
      var segments = splitReply(message.content, widgets);
      await mountSegmentsInstant(turn, segments);
      return turn;
    }

    /**
     * R1 — rebuilds the thread from persisted sessionStorage state when one
     * exists (run instead of streamIntro). The greeting is restored as a
     * plain first turn and every stored message is mounted instantly, then
     * the suggestions widget lands at the bottom and the saved scroll
     * position is restored once layout settles. `history` is replaced by the
     * restored messages, so the conversation continues exactly where it was
     * left.
     */
    function restoreThread(state) {
      history = state.messages;

      // The server-rendered intro (no-JS/SEO resilience) is dropped like in
      // streamIntro; the greeting renders instantly instead of streaming.
      thread.replaceChildren();

      var introTurn = document.createElement("div");
      introTurn.className = "ask-assistant";
      var introParagraph = document.createElement("p");
      introParagraph.className = "ask-paragraph ask-paragraph--first";
      introParagraph.textContent = INTRO_TEXT;
      introTurn.append(introParagraph);
      thread.append(introTurn);

      var lastTurn = introTurn;
      setBusy(true);

      (async function () {
        for (var i = 0; i < history.length; i += 1) {
          var message = history[i];
          if (message.role === "user") {
            lastTurn = appendUserTurn(message.content);
          } else {
            lastTurn = await appendAssistantTurnInstant(message);
          }
        }

        // The suggestions wrap lives at the bottom, as it would in a live
        // chat.
        suggestionsWrap = buildSuggestions();
        lastTurn.after(suggestionsWrap);
        scrollThreadBottom(thread);

        // All widget renders and the suggestions insert are done: restore
        // the saved scroll position at the next frame. A thread that is not
        // scrollable yields 0 naturally.
        requestAnimationFrame(function () {
          var max = thread.scrollHeight - thread.clientHeight;
          thread.scrollTop = max > 0 ? clampRatio(state.scrollRatio) * max : 0;
        });

        setBusy(false);
        input.focus();
      })();
    }

    // R1: the conversation survives navigation in this tab.
    window.addEventListener("pagehide", saveChatState);

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var question = input.value;
      if (question.trim() === "") {
        input.focus();
        return;
      }

      void ask(question);
    });

    // R1: restore the persisted conversation when one exists, otherwise
    // greet a fresh visitor. A null/empty state falls through to the
    // unchanged fresh-visit path.
    var restored = loadChatState();
    if (restored === null || restored.messages.length === 0) {
      streamIntro();
    } else {
      void restoreThread(restored);
    }
  }

  init();
})();