# Feature: gemini-provider — Gemini free tier como proveedor de IA del chat

## Goal

Probar el tier gratuito de la Gemini API como proveedor del chat del porfolio (workers AI free quota agotada), integrado **a través del Worker** (Browser → Worker → Gemini), manteniendo el contrato `/api/chat`, el loop de herramientas `get_knowledge_document`, los widgets y el diseño de caída actual. Sin cambiar frontend, sin fallback multi-proveedor (fuera de scope V1), sin deploy (pendiente de decisión del usuario).

## Canonical brief (condensado para este feature)

1. **Frontera de proveedor**: implementar `AIProvider` (`worker/src/ai.ts`). Selección única en `index.ts` default export por env `AI_PROVIDER`: `mock | gemini | cloudflare`.
2. **Vía elegida: endpoint OpenAI-compatible** de Gemini (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`). Verificado en docs oficiales (2026-02): soporta function calling (`tools` con `type:"function"`), role `system` y nombres de modelo Gemini. El contrato interno del worker ya es OpenAI-shaped (documentado en `chat.ts`), así que el adaptador mapea mensajes y tools casi 1:1; NO se toca `chat.ts`.
3. **Normalización**: reutilizar los normalizadores de `ai.ts` (exportados: `normalizeResponseText`, `normalizeToolArguments`) desde un nuevo `worker/src/gemini.ts`; desarmar la respuesta OpenAI (`choices[0].message.content` / `.tool_calls` con `function.{name,arguments}`). Invariante del repo: nunca lanzar ante payloads raros de proveedor.
4. **Config**: `GEMINI_API_KEY` como secreto (`.dev.vars` local + `wrangler secret put` en prod; **nunca** en `[vars]`). `[vars]`: `AI_PROVIDER = "gemini"`, `MODEL_ID = "gemini-3.6-flash"`. `.dev.vars` se añade a `.gitignore` (hoy NO está cubierto).
5. **Errores**: fallos de red/HTTP/429 → `ChatRunError("ai_error")` → `502 ai_unavailable` del contrato (retryable). Sin stack traces.
6. **Límites free tier**: página oficial remite a AI Studio (`aistudio.google.com/rate-limit`, solo visible con key real). Estimaciones terceros post-dic-2025 para 2.5 Flash free ≈ 250–1.500 RPD / 250K–1M TPM / 10–15 RPM → **verificar con la key real**. Coste por pregunta: ≤4 llamadas al modelo (3 turnos de tool + settle) ⇒ ≈ 3–4 mensajes/minuto; suficiente para un porfolio personal.
7. **Privacidad**: el tier gratuito puede usar peticiones para mejorar productos; existe opción UE/toggle en AI Studio. Contenido público → riesgo bajo, informado al usuario.

## Decisions (user-confirmed 2026-02)

| Decision | Value |
| --- | --- |
| Proveedor a probar | Gemini API free tier, modelo **gemini-3.6-flash** (2.5-flash retirado: 404 "no longer available to new users") |
| Alcance | **Local + dejar listo prod** (sin ejecutar deploy; secret remoto y deploy = decisión del usuario) |
| Endpoint | OpenAI-compatible (`/v1beta/openai/chat/completions`); fallback si falla el tool calling = adaptador nativo REST (`generateContent` + `functionDeclarations`) |
| Selección de proveedor | `AI_PROVIDER` env: `mock` (CLI only) \| `gemini` (defecto tras este feature) \| `cloudflare` (legacy) |
| Clave | Local `.dev.vars` (gitignored); prod `wrangler secret put GEMINI_API_KEY` |
| Deploy | Pendiente (decisión usuario): Vercel + `wrangler deploy` con `ALLOWED_ORIGINS` real |
| Fallback multi-proveedor | NO (fuera de scope V1): Gemini caído → `502 ai_unavailable` + UX actual |

## TDD mode

- Mode: **off** (sin config de proyecto; no solicitado). Checks: `cd worker && bun run test` (vitest), `cd worker && bun run check` (tsc), revisión de docs. Frontend no se toca → no hace falta `astro check/build` en cada unidad, solo en la verificación consolidada si procede.
- Nota de entorno: `bun --cwd <dir> run <script>` imprime help en este entorno → usar `cd <dir> && bun run <script>`.

## Delivery strategy

`ask-on-risk`. Ramas: `feat/gemini-provider` (creada desde `main`). Work-unit commits por tarea. Push/PR/merge: decisión del usuario. RDD: native review no disponible en este entorno según ledger (facade gap `base_ref`); a re-evaluar en el cierre según switch (`gentle-ai review mode status`).

## Tasks

| # | Task | Status | Route | Checks | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1 | gemini-adapter: `GeminiOpenAIProvider` en `worker/src/gemini.ts` + exports de normalizadores en `ai.ts` + unit tests (fetch mockeado) | done (e78102e) | writer (gentle-ai-worker) | vitest + tsc | pass — 13 tests nuevos, suite 213 en verde; invariantes verificados por gentle-ai-verify |
| 2 | gemini-config: `Env.GEMINI_API_KEY`, selección en `index.ts`, `wrangler.toml` `[vars]`, `.gitignore` (+ `.dev.vars`), runbook README | done (54f2385) | writer | tsc + tests + review | pass — writer validation + verify consolidado PASS (sin blockers, sin secretos) |
| 3 | verify-full: worker test + tsc + revisión de set de cambios | done | verify (gentle-ai-verify) | all | PASS — tsc 0 diagnostics, 213/213 tests, invariantes confirmados (frontera, sin secretos, chat.ts intacto); 2 notas cosméticas resueltas |
| 4 | smoke-live: key real, recuperación de documentos, widgets, rechazo off-topic, cuotas reales en AI Studio, decisión de producción | partial (cuota free tier de 3.6-flash agotada hoy) | manual | live | válido parcial — ver sección Smoke-live evidence; loop completo pendiente de ventana de cuota |

## Work-unit commit ledger

| Commit | Task | Tier (RDD) | Outcome |
| --- | --- | --- | --- |
| e78102e feat(worker gemini adapter) | 1 | pending assess | writer validation: tsc 0 + suite 213/213; verify consolidado PASS (sin blockers) |
| 54f2385 feat(worker gemini config) | 2 | pending assess | writer validation + verify PASS; newline final añadido en gemini.ts |
| (rama feat/gemini-provider, cierre) | 1–3 | native review decline | gentle_review START → consent-declined-this-candidate (sin lineage, sin mutación; decisión del usuario). Validación efectiva: writer validation + gentle-ai-verify consolidado PASS (verificador separado, barra RDD-off) |
| c985be3 fix(worker gemini compat) | 4 | pending assess | live-driven fix: reasoning_effort minimal + drop `name` en tool messages; 214 tests |
| (candidate rama, cierre) | 4 | pending live | smoke partial: primer turno 200 + tool_calls[skills] en vivo; loop completo pendiente de cuota |

## App contract deltas

- `/api/chat` request/response: **sin cambios** (reply, widgets, sources, errores 400/422/429/502).
- `/health`: `model` pasa a reportar `gemini-3.6-flash` con la config nueva.
- Selección de proveedor: `env.AI_PROVIDER === "mock"` → Mock; `=== "gemini"` → `new GeminiOpenAIProvider(env.GEMINI_API_KEY, env.MODEL_ID)`; ausente/otro → Cloudflare legacy.
- `AiTool` → payload compat: envolver en `{ type: "function", function: { name, description, parameters } }`; omitir `tools` cuando está vacío (invariante CF: array vacío rechazado).
- Mensajes: `system` como primer mensaje (mismo patrón que CF); `content: ""` en mensajes assistant con `tool_calls` → `null` en la frontera del adaptador (esperado por el shape OpenAI).

## Known risks

| Riesgo | Mitigación |
| --- | --- |
| Números reales de cuota free tier desconocidos hasta tener key | Verificar en `aistudio.google.com/rate-limit` en tarea 4; ajustar frequencia/limits si es necesario |
| Compat endpoint rechaza algún shape del loop (`content` ""/null, ids de tool_call) | Mapeo defensivo en la frontera (nunca en `chat.ts`); si el tool calling falla en vivo → opción B nativa REST |
| Uso de datos para entrenamiento en free tier | Informado al usuario (toggle UE/opt-out disponible) |
| 429 global por RPM del proyecto | El gate de rate-limit por IP del worker (~30/min) puede superar RPM de Gemini en ráfagas; aceptable para uso personal; nota en runbook |
| 4006 de Workers AI si se vuelve a CF | Ya resuelto: Gemini es el defecto nuevo; CF sigue disponible solo vía `--var` |

## Smoke-live evidence (2026-02, key real del usuario)

Validado en vivo contra el tier gratuito (endpoint OpenAI-compatible):

| Prueba | Resultado |
| --- | --- |
| Key real + ListModels | **200**, 61 modelos disponibles |
| `gemini-2.5-flash` / `2.5-flash-lite` | **404** "no longer available to new users" → retirados; default cambiado a `gemini-3.6-flash` |
| Primer turno con system prompt real + tool (3.6-flash) | **200**, `tool_calls` → `{"document_id":"skills"}` en ~1.3 s |
| `reasoning_effort: minimal` (3.6-flash) | 200 con contenido real a 64 tokens, ~1 s (sin él: respuestas vacías / `MALFORMED_FUNCTION_CALL`) |
| `gemini-3.5-flash` / `3.8-flash` | **503** "high demand" (temporal) |
| `gemini-3-flash-preview` | **400** con el adaptador actual (causa no investigada a fondo para no quemar cuota) |
| Off-topic (camino completo, 3.6-flash) | **200** en 3.4 s, redirección cortés correcta (antes de quemar cuota) |
| Cuota free tier 3.6-flash | **~20 requests/ventana**: 429 con "retry in Xs" que NO se recupera en minutos (ni tras 5 min sin llamadas) → techo real a comprobar en AI Studio; hoy agotada, loop completo pendiente |
| `wrangler dev` local en esta máquina | **bloqueado por entorno**: workerd resuelve el host de Gemini por IPv6 (AAAA-first) y esta máquina no tiene ruta IPv6 → connect fail ~10 ms. Node/Bun alcanzan el endpoint (fallback IPv4). En Cloudflare edge (prod) no aplica. Solución local opcional: pin IPv4 en hosts |

Pendiente: re-ejecutar el smoke del loop completo (skills, proyectos+widgets, imagen+widget, off-topic) cuando la ventana de cuota se libere, y decidir producción con el techo real visible en AI Studio.