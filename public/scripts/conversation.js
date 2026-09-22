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
    return { reply: payload.reply, sources: sources };
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

  function init() {
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
     * .ask-paragraph (textContent only).
     */
    function buildAssistantTurn(text) {
      return new Promise(function (resolve) {
        var turn = document.createElement("div");
        turn.className = "ask-assistant";

        var paragraph = document.createElement("p");
        paragraph.className = "ask-paragraph";
        turn.append(paragraph);

        thread.append(turn);
        scrollThreadBottom(thread);

        streamText(paragraph, text, thread, function () {
          scrollThreadBottom(thread);
          resolve();
        });
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
      if (value && thinking.querySelectorAll(".thinking-dot").length === 0) {
        thinking.append(createDot(), createDot(), createDot());
      }
      thinking.hidden = !value;
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
        history.push({ role: "assistant", content: response.reply });
        await buildAssistantTurn(response.reply);
      } catch (error) {
        var failure = readFailure(error);
        showError(failure.code, failure.message);
      } finally {
        window.clearTimeout(timeout);
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