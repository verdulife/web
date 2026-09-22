/**
 * conversation.js — editorial conversation client for the portfolio
 * (portfolio-ai, task 6).
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
 *     .ask-button        submit button ("Publicar")
 *     .ask-suggestions   container of .ask-suggestion buttons (data-question)
 *     .ask-thread        role="log" region where turns are appended
 *     .ask-thinking      hidden thinking row shown while a request is in flight
 *     .ask-error         hidden error row; its content is built here
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
      ? payload.sources.filter(
          function (source) {
            return typeof source === "string" && source !== "";
          },
        )
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

  function init() {
    var root = document.getElementById(HOOK_ROOT_ID);
    if (!root) return;

    var form = root.querySelector(".ask-form");
    var input = root.querySelector(".ask-input");
    var submitButton = root.querySelector(".ask-button");
    var suggestionsWrap = root.querySelector(".ask-suggestions");
    var thread = root.querySelector(".ask-thread");
    var thinking = root.querySelector(".ask-thinking");
    var errorBox = root.querySelector(".ask-error");

    if (
      !form ||
      !input ||
      !submitButton ||
      !suggestionsWrap ||
      !thread ||
      !thinking ||
      !errorBox
    ) {
      return;
    }

    var history = [];
    var questionCount = 0;
    var thinkingBusy = false;

    function setThinking(value) {
      thinkingBusy = value;
      input.disabled = value;
      submitButton.disabled = value;

      var buttons = suggestionsWrap.querySelectorAll(".ask-suggestion");
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = value;

      if (value && !thinking.querySelector(".ask-thinking-dots")) {
        var dots = document.createElement("span");
        dots.className = "ask-thinking-dots";
        dots.setAttribute("aria-hidden", "true");
        dots.append(createDot(), createDot(), createDot());
        thinking.append(dots);
      }

      thinking.hidden = !value;
    }

    function appendUserTurn(question) {
      questionCount += 1;

      var turn = document.createElement("div");
      turn.className = "ask-user";

      var meta = document.createElement("p");
      meta.className = "mono-meta";
      meta.textContent = "PREGUNTA " + String(questionCount).padStart(2, "0");

      var ask = document.createElement("p");
      ask.className = "ask-question";

      var dash = document.createElement("span");
      dash.className = "ask-dash";
      dash.setAttribute("aria-hidden", "true");
      dash.textContent = "— ";

      ask.append(dash, document.createTextNode(question));
      turn.append(meta, ask);
      thread.append(turn);
    }

    function appendAssistantTurn(reply, sources) {
      var turn = document.createElement("div");
      turn.className = "ask-assistant";

      var blocks = reply.split("\n\n");
      for (var i = 0; i < blocks.length; i += 1) {
        var paragraph = blocks[i].trim();
        if (paragraph === "") continue;

        var element = document.createElement("p");
        element.className = "ask-paragraph";
        // Untrusted model text: text nodes only, never innerHTML.
        element.textContent = paragraph;
        turn.append(element);
      }

      if (sources.length > 0) {
        var fuentes = document.createElement("p");
        fuentes.className = "mono-meta ask-fuentes";
        fuentes.textContent = "// fuentes: " + sources.join(", ");
        turn.append(fuentes);
      }

      thread.append(turn);
    }

    function showError(code, providerMessage) {
      errorBox.replaceChildren();

      var kicker = document.createElement("p");
      kicker.className = "kicker";
      kicker.textContent = "SERVICIO NO DISPONIBLE";

      var message = document.createElement("p");
      message.className = "ask-error-message";
      message.textContent = messageFor(code, providerMessage);

      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ask-retry";
      retry.textContent = "Reintentar";
      retry.addEventListener("click", function () {
        var last = history[history.length - 1];
        if (!last || last.role !== "user" || thinkingBusy) return;
        // Resends the last question: it is still the tail of the thread.
        void runRequest();
      });

      errorBox.append(kicker, message, retry);
      errorBox.hidden = false;
      retry.focus();
    }

    async function runRequest() {
      if (thinkingBusy) return;

      errorBox.hidden = true;
      setThinking(true);

      var controller = new AbortController();
      var timeout = window.setTimeout(function () {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        var response = await postChat(history, controller.signal);
        history.push({ role: "assistant", content: response.reply });
        appendAssistantTurn(response.reply, response.sources);
        thread.focus();
      } catch (error) {
        var failure = readFailure(error);
        showError(failure.code, failure.message);
      } finally {
        window.clearTimeout(timeout);
        setThinking(false);
      }
    }

    async function ask(question) {
      var trimmed = question.trim();
      if (trimmed === "" || thinkingBusy) return;

      history.push({ role: "user", content: trimmed });
      appendUserTurn(trimmed);
      input.value = "";
      await runRequest();
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

    suggestionsWrap.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;

      var button = target.closest(".ask-suggestion");
      if (!button || thinkingBusy) return;

      var question = button.dataset.question ?? "";
      if (question === "") return;

      input.value = question;
      void ask(question);
    });
  }

  init();
})();