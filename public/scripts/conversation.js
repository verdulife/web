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
   *   PortfolioWidgets.register(type, renderer)
   *     Stores a plain-function renderer under a non-empty string `type`;
   *     returns nothing.
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

  function register(type, renderer) {
    if (typeof type !== "string" || type === "" || typeof renderer !== "function") return;
    widgetRegistry[type] = renderer;
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
    var renderer = widgetRegistry[type];
    if (typeof renderer !== "function") return null;

    var node;
    try {
      node = await renderer(widget, { resolveLinkMeta: linkMetaResolver });
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
   * `<img class="widget-image-img">` and an optional
   * `<span class="widget-image-caption">`. The wrapper is a span (phrasing
   * content, valid inside the `.ask-paragraph` `<p>`) styled as a block figure
   * by CSS (I5); `figure`/`figcaption` are not allowed inside `<p>`. `src`
   * must be a safe site-relative path and `alt` a non-empty string — anything
   * invalid drops the placeholder (returns null). `caption`, when present and
   * non-empty, is set via textContent only. Nodes are built with
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

    var caption = typeof widget.caption === "string" ? widget.caption.trim() : "";
    if (caption !== "") {
      var captionNode = document.createElement("span");
      captionNode.className = "widget-image-caption";
      captionNode.textContent = caption.slice(0, MAX_WIDGET_IMAGE_TEXT_CHARS);
      figure.appendChild(captionNode);
    }

    return figure;
  }

  window.PortfolioWidgets.register("image", renderImage);

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
   * Streams split segments into `paragraph` in order. Text segments type
   * char-by-char into their own Text node; widget segments pause the
   * typewriter, resolve asynchronously via renderWidgetNode, append the node
   * when non-null, then continue. With prefers-reduced-motion the text lands
   * instantly and no timers run; widget nodes still resolve sequentially.
   */
  function streamSegments(paragraph, segments, thread) {
    return new Promise(function (resolve) {
      var reduced = prefersReducedMotion();
      var index = 0;

      function next() {
        if (index >= segments.length) {
          scrollThreadBottom(thread);
          resolve();
          return;
        }
        var segment = segments[index];
        index += 1;

        if (segment.kind === "text") {
          var textNode = document.createTextNode("");
          paragraph.append(textNode);
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
          if (node) {
            paragraph.append(node);
            scrollThreadBottom(thread);
          }
          next();
        });
      }

      next();
    });
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
     * Appends an assistant turn and streams its reply into a single
     * .ask-paragraph (textContent only). Without widgets the previous
     * single-pass streamText behavior is kept unchanged; with widget segments
     * the reply streams per segment, pausing the typewriter while each widget
     * resolves into the paragraph.
     */
    function buildAssistantTurn(text, widgets) {
      return new Promise(function (resolve) {
        var turn = document.createElement("div");
        turn.className = "ask-assistant";

        var paragraph = document.createElement("p");
        paragraph.className = "ask-paragraph";
        turn.append(paragraph);

        thread.append(turn);
        scrollThreadBottom(thread);

        var segments = splitReply(text, widgets);
        var untouchedPlainText =
          segments.length === 1 && segments[0].kind === "text" && segments[0].text === text;

        if (untouchedPlainText) {
          // No widget segments and the text was not altered: the unchanged
          // streamText path (byte-for-byte for the no-widget replies).
          streamText(paragraph, text, thread, function () {
            scrollThreadBottom(thread);
            resolve();
          });
          return;
        }

        streamSegments(paragraph, segments, thread).then(resolve);
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
        history.push({ role: "assistant", content: response.reply });
        await buildAssistantTurn(response.reply, response.widgets ?? []);
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

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var question = input.value;
      if (question.trim() === "") {
        input.focus();
        return;
      }

      void ask(question);
    });

    streamIntro();
  }

  init();
})();