import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activatePi, type PiExtensionAPI } from "../src/pi.ts";
import { activateOmp, type OmpExtensionAPI } from "../src/omp.ts";
import { extractOmniRouteModel, normalizeCatalog, omniRouteConfigPath, readConfig, resolvedRouteStatus } from "../src/shared.ts";

interface RegisteredProvider {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<{
    id: string;
    name?: string;
    api?: string;
    baseUrl?: string;
    preferWebsockets?: boolean;
    remoteCompaction?: {
      enabled?: boolean;
      api?: string;
      v2StreamingEnabled?: boolean;
      endpoint?: string;
      v2Endpoint?: string;
    };
    compat?: Record<string, unknown>;
  }>;
  streamSimple?: (...args: any[]) => AsyncIterable<unknown>;
}

type FakeOmpHandler = (event: { payload?: unknown }, context: FakeContext) => unknown;

class FakeOmpHost implements OmpExtensionAPI {
  provider?: { name: string; config: RegisteredProvider };
  thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  handlers = new Map<string, FakeOmpHandler[]>();

  registerProvider(name: string, config: RegisteredProvider): void {
    this.provider = { name, config };
  }

  getThinkingLevel(): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
    return this.thinkingLevel;
  }

  on(event: string, handler: FakeOmpHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: string, context: FakeContext): void {
    for (const handler of this.handlers.get(event) ?? []) handler({}, context);
  }
  async emitBeforeProviderRequest(payload: unknown, context: FakeContext): Promise<unknown> {
    let current = payload;
    for (const handler of this.handlers.get("before_provider_request") ?? []) {
      current = await handler({ payload: current }, context) ?? current;
    }
    return current;
  }

}


interface FakeContext {
  model?: { id: string; name: string };
  hasUI: boolean;
  statuses: Array<[string, string | undefined]>;
  ui: { setStatus(key: string, text: string | undefined): void };
}
function fakeContext(model?: { id: string; name: string }): FakeContext {
  const statuses: Array<[string, string | undefined]> = [];
  return { model, hasUI: true, statuses, ui: { setStatus: (key, text) => statuses.push([key, text]) } };
}

class FakePiHost implements PiExtensionAPI {
  provider?: { name: string; config: RegisteredProvider };
  handlers = new Map<string, Array<(event: unknown, context: FakeContext) => void | Promise<void>>>();

  registerProvider(name: string, config: RegisteredProvider): void {
    this.provider = { name, config };
  }

  on(event: string, handler: (event: unknown, context: FakeContext) => void | Promise<void>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

/**
 * Config discovery falls back to `$HOME/.omp/agent` when `PI_CODING_AGENT_DIR` is
 * unset, so tests that omit it would read the developer's real `omniroute.yml`.
 * Every activation test pins an empty directory to keep defaults deterministic.
 */
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    OMNIROUTE_API_KEY: "secret",
    PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "omniroute-agent-")),
    ...extra,
  };
}

/** Verbatim frames from OmniRoute's open-sse/utils/earlyStreamKeepalive.ts. */
const CHAT_KEEPALIVE_FRAME =
  'data: {"id":"omniroute-keepalive","object":"chat.completion.chunk","created":0,"model":"omniroute",'
  + '"choices":[{"index":0,"delta":{"reasoning_content":"OmniRoute: got request, sending to provider"},"finish_reason":null}]}';
const RESPONSES_KEEPALIVE_FRAME = [
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_omniroute_keepalive","type":"reasoning","summary":[]}}',
  "",
  'event: response.reasoning_summary_text.delta',
  'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_omniroute_keepalive","output_index":0,"summary_index":0,'
  + '"delta":"OmniRoute: got request, sending to provider"}',
  "",
].join("\n");

describe("shared catalog logic", () => {
  test("preserves discovered metadata and configured effort levels", () => {
    const result = normalizeCatalog({
      data: [{
        id: "combo/coding",
        owned_by: "combo",
        context_length: 200000,
        max_output_tokens: 64000,
        capabilities: {
          reasoning: true,
          thinking: true,
          tool_calling: true,
          vision: true,
          effort_tiers: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        },
      }],
    }, {
      effortOverrides: { "combo/coding": ["low", "medium", "high", "max"] },
    });

    expect(result.models[0]).toMatchObject({
      id: "combo/coding",
      name: "combo/coding",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "medium", "high", "max"] },
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 64000,
      compat: { supportsReasoningEffort: true },
    });
  });

  test("preserves catalog model names with an id fallback", () => {
    const result = normalizeCatalog({
      data: [
        { id: "gpt-5.5", name: "GPT-5.5 Codex", owned_by: "codex" },
        { id: "unnamed/model", name: "  " },
      ],
    }, { effortOverrides: {} });

    expect(result.models.map(model => model.name)).toEqual(["GPT-5.5 Codex", "unnamed/model"]);
  });

  test("supports minimal when discovered but omits it from fallback defaults", () => {
    const discovered = normalizeCatalog({
      data: [{ id: "combo/coding", owned_by: "combo", capabilities: { reasoning: true, effort_tiers: ["minimal", "low", "high"] } }],
    }, { effortOverrides: {} });
    expect(discovered.models[0]?.thinking?.efforts).toEqual(["minimal", "low", "high"]);
    expect(normalizeCatalog({
      data: [{ id: "default", capabilities: { reasoning: true } }],
    }, { effortOverrides: {} }).models[0]?.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("exposes fallback effort controls without capability or owner metadata", () => {
    const result = normalizeCatalog({
      data: [{ id: "any/model" }],
    }, { effortOverrides: {} });

    expect(result.models[0]).toMatchObject({
      id: "any/model",
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  test("maps input_modalities and structured_output from the live catalog shape", () => {
    const result = normalizeCatalog({
      data: [
        // Live shape: top-level input_modalities array, vision absent.
        { id: "modal/vision", input_modalities: ["text", "image"], capabilities: { reasoning: true } },
        // Richer modalities collapse to the host's text|image vocabulary.
        { id: "modal/rich", input_modalities: ["text", "image", "audio", "video", "pdf"] },
        // Text-only stays text-only.
        { id: "modal/text", input_modalities: ["text"], capabilities: { vision: false } },
        // Structured output boolean drives the strict-mode compat flag.
        { id: "so/true", capabilities: { structured_output: true } },
        { id: "so/false", capabilities: { structured_output: false } },
      ],
    }, { effortOverrides: {} });

    expect(result.models.map(m => m.input)).toEqual([
      ["text", "image"],
      ["text", "image"],
      ["text"],
      ["text"],
      ["text"],
    ]);
    expect(result.models.map(m => m.compat.supportsStrictMode)).toEqual([false, false, false, true, false]);
  });

  test("honors explicit non-reasoning capability metadata", () => {
    const result = normalizeCatalog({
      data: [{ id: "plain/model", capabilities: { reasoning: false } }],
    }, { effortOverrides: {} });

    expect(result.models[0]).toMatchObject({ id: "plain/model", reasoning: false });
    expect(result.models[0]?.thinking).toBeUndefined();
  });

  test("applies exact, wildcard, catalog, then default effort precedence", () => {
    const payload = {
      data: [
        { id: "exact", capabilities: { reasoning: true, effort_tiers: ["low"] } },
        { id: "wildcard", capabilities: { reasoning: true, effort_tiers: ["medium"] } },
      ],
    };
    const overridden = normalizeCatalog(payload, {
      effortOverrides: { exact: ["max"], "*": ["high", "xhigh"] },
    });
    expect(overridden.models.map(model => model.thinking?.efforts)).toEqual([["max"], ["high", "xhigh"]]);

    const discovered = normalizeCatalog(payload, { effortOverrides: {} });
    expect(discovered.models.map(model => model.thinking?.efforts)).toEqual([["low"], ["medium"]]);
    expect(normalizeCatalog({
      data: [{ id: "default", capabilities: { reasoning: true } }],
    }, { effortOverrides: {} }).models[0]?.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("reads per-model efforts from YAML in the host config folder", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-config-"));
    const configPath = join(agentDir, "omniroute.yml");
    writeFileSync(configPath, 'combo/custom: [minimal, low, max]\n"*": [low, medium, high, xhigh]\n');

    expect(omniRouteConfigPath("omp", { PI_CODING_AGENT_DIR: agentDir })).toBe(configPath);
    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath).effortOverrides).toEqual({
      "combo/custom": ["minimal", "low", "max"],
      "*": ["low", "medium", "high", "xhigh"],
    });
    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }, join(agentDir, "missing.yml")).effortOverrides).toEqual({});
  });

  test("reads the API format from YAML, defaulting to responses", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-format-"));
    const configPath = join(agentDir, "omniroute.yml");

    expect(readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath).format).toBe("responses");

    writeFileSync(configPath, "format: chat_completions\ncombo/custom: [low, high]\n");
    const config = readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath);
    expect(config.format).toBe("chat_completions");
    expect(config.effortOverrides).toEqual({ "combo/custom": ["low", "high"] });

    writeFileSync(configPath, "format: completions\n");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow('"chat_completions" or "responses"');
  });

  test("rejects invalid catalogs and YAML effort overrides", () => {
    expect(() => normalizeCatalog({}, { effortOverrides: {} })).toThrow("data[]");
    expect(() => normalizeCatalog({ data: [] }, { effortOverrides: {} })).toThrow("no usable models");
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-invalid-config-"));
    const configPath = join(agentDir, "omniroute.yml");
    writeFileSync(configPath, "combo/custom: [ultra]\n");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Unsupported reasoning effort");
    writeFileSync(configPath, "[broken");
    expect(() => readConfig({ OMNIROUTE_API_KEY: "secret" }, configPath)).toThrow("Invalid OmniRoute config");
  });

  test("extracts the routed model from a live chunk or trailer", () => {
    expect(extractOmniRouteModel([
      'data: {"model":"vendor/live-model","choices":[]}',
    ])).toBe("vendor/live-model");
    expect(extractOmniRouteModel([
      ": x-omniroute-model=vendor/trailer-model",
      "data: [DONE]",
    ])).toBe("vendor/trailer-model");
    expect(extractOmniRouteModel(["data: [DONE]"])).toBeUndefined();
  });

  test("never attributes routing to OmniRoute's own keepalive frames", () => {
    // Both formats stamp model "omniroute" on the synthetic frame; treating that as
    // a resolution would flash a bogus "requested▸omniroute" status line.
    expect(extractOmniRouteModel([CHAT_KEEPALIVE_FRAME])).toBeUndefined();
    expect(extractOmniRouteModel(RESPONSES_KEEPALIVE_FRAME.split("\n"))).toBeUndefined();
    expect(extractOmniRouteModel([
      'data: {"id":"provider-chunk","object":"chat.completion.chunk","model":"omniroute","choices":[{"index":0,"delta":{"reasoning_content":"actual provider reasoning"}}]}',
    ])).toBe("omniroute");
    expect(extractOmniRouteModel([
      'data: {"id":"omniroute-keepalive","object":"chat.completion.chunk","model":"omniroute","choices":[{"index":0,"delta":{}}]}',
    ])).toBeUndefined();
  });

  test("reads the routed model from a Responses envelope", () => {
    expect(extractOmniRouteModel([
      'data: {"type":"response.created","response":{"id":"resp_1","model":"vendor/live-model"}}',
    ])).toBe("vendor/live-model");
  });

  test("only distinguishes routed models when the response model differs", () => {
    expect(resolvedRouteStatus("direct/model", "direct/model")).toBe("direct/model");
    expect(resolvedRouteStatus("requested/model", "routed/model")).toBe("requested/model▸routed/model");
  });

});

describe("OMP adapter", () => {
  test("does not install process-wide fatal handlers during guarded activation", () => {
    const fixture = join(import.meta.dir, "fixtures", "guarded-omp-activation.ts");
    const result = Bun.spawnSync({ cmd: [process.execPath, fixture] });
    const stderr = result.stderr.toString();

    expect(result.exitCode, stderr).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      providerRegistrations: 1,
      uncaughtException: 0,
      unhandledRejection: 0,
      exit: 0,
      SIGINT: 0,
      SIGTERM: 0,
      SIGHUP: 0,
      SIGUSR1: 0,
    });
  });
  test("registers fetched models before activation resolves", async () => {
    const host = new FakeOmpHost();
    await activateOmp(
      host,
      isolatedEnv({ OMNIROUTE_BASE_URL: "http://router.test" }),
      async () => Response.json({
        data: [{ id: "any/model", capabilities: { reasoning: true } }],
      }),
    );

    expect(host.provider?.name).toBe("omniroute");
    expect(host.provider?.config.baseUrl).toBe("http://router.test/v1");
    expect(host.provider?.config.apiKey).toBe("secret");
    expect(host.provider?.config.api).toBe("omniroute-openai-responses");
    expect(host.provider?.config.models.map(model => model.id)).toEqual(["any/model"]);
  });
  test("keeps the catalog model name immediately after startup binding", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "combo/coding", name: "Coding Router", owned_by: "combo" }],
    }));

    expect(host.provider?.config.models[0]?.name).toBe("Coding Router");
    const context = fakeContext({ ...host.provider!.config.models[0]!, name: host.provider!.config.models[0]!.name! });
    host.emit("session_start", context);
    expect(context.model?.name).toBe("Coding Router");
  });
  test("uses native Codex transport and remote compaction only for direct Codex models", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [
        { id: "gpt-5.5", name: "GPT-5.5 Codex", owned_by: "codex" },
        { id: "combo/coding", name: "Coding Router", owned_by: "combo" },
      ],
    }));

    expect(host.provider?.config.models[0]).toMatchObject({
      id: "gpt-5.5",
      name: "GPT-5.5 Codex",
      api: "openai-codex-responses",
      preferWebsockets: false,
      remoteCompaction: {
        enabled: true,
        api: "openai-codex-responses",
        v2StreamingEnabled: true,
      },
    });
    expect(host.provider?.config.models[1]).toMatchObject({ id: "combo/coding", name: "Coding Router" });
    expect(host.provider?.config.models[1]?.api).toBeUndefined();
    expect(host.provider?.config.models[1]?.preferWebsockets).toBeUndefined();
    expect(host.provider?.config.models[1]?.remoteCompaction).toBeUndefined();
  });
  test("parks pi-ai's Codex URL suffix in the query for direct Codex models", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ OMNIROUTE_BASE_URL: "http://router.test" }), async () => Response.json({
      data: [{ id: "gpt-5.5", name: "GPT-5.5 Codex", owned_by: "codex" }],
    }));

    const model = host.provider!.config.models[0];
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.baseUrl).toBe("http://router.test/v1/responses?omniroute-codex=");
    // pi-ai appends `/codex/responses` to any non-Codex base URL; the `?`
    // terminator parks that suffix in the query so the SSE path stays
    // OmniRoute's `/v1/responses`.
    expect(new URL(`${model!.baseUrl}/codex/responses`).pathname).toBe("/v1/responses");
  });
  test("registers OmniRoute Responses endpoint for Codex V2-only compaction", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ OMNIROUTE_BASE_URL: "http://router.test" }), async () => Response.json({
      data: [{ id: "gpt-5.5", owned_by: "codex" }],
    }));

    // V1 `/responses/compact` is not advertised: the ChatGPT Codex backend answers
    // it with a plain generate response (no compaction item), which pi-agent-core's
    // V1 handler rejects. Only V2 (`compaction_trigger`) yields a real compaction.
    expect(host.provider?.config.models[0]?.remoteCompaction).toEqual({
      enabled: true,
      api: "openai-codex-responses",
      v2StreamingEnabled: true,
      v2Endpoint: "http://router.test/v1/responses",
    });
    expect(host.provider?.config.models[0]?.remoteCompaction?.endpoint).toBeUndefined();
  });
  test("reuses main discovery when a subagent activation cannot reach OmniRoute", async () => {
    const environment = isolatedEnv({ OMNIROUTE_BASE_URL: "http://router.test" });
    const mainHost = new FakeOmpHost();
    await activateOmp(mainHost, environment, async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));

    const subagentHost = new FakeOmpHost();
    await activateOmp(subagentHost, environment, async () => {
      throw new Error("subagent discovery unavailable");
    });

    expect(mainHost.provider?.config.apiKey).toBe("secret");
    expect(subagentHost.provider).toBeDefined();
    expect(subagentHost.provider?.config.apiKey).toBe("secret");
    expect(subagentHost.provider?.config.models.map(model => model.id)).toEqual(["combo/coding"]);
    expect(subagentHost.provider!.config.models[0]).not.toBe(mainHost.provider!.config.models[0]);
  });

  test("does not reuse cached discovery across connection settings", async () => {
    const environment = isolatedEnv({
      OMNIROUTE_API_KEY: "main-secret",
      OMNIROUTE_BASE_URL: "http://router.test",
    });
    const mainHost = new FakeOmpHost();
    await activateOmp(mainHost, environment, async () => Response.json({
      data: [{ id: "main/model" }],
    }));

    const otherCredentialHost = new FakeOmpHost();
    await activateOmp(otherCredentialHost, { ...environment, OMNIROUTE_API_KEY: "other-secret" }, async () => {
      throw new Error("other credential unavailable");
    });
    const otherEndpointHost = new FakeOmpHost();
    await activateOmp(otherEndpointHost, { ...environment, OMNIROUTE_BASE_URL: "http://other-router.test" }, async () => {
      throw new Error("other endpoint unavailable");
    });

    expect(mainHost.provider?.config.models.map(model => model.id)).toEqual(["main/model"]);
    expect(otherCredentialHost.provider).toBeUndefined();
    expect(otherEndpointHost.provider).toBeUndefined();
  });


  test("updates combo routing after resuming an older session", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "combo/coding", name: "Coding Router", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);

    // OMP emits session_switch before restoring the resumed session's model.
    host.emit("session_switch", context);
    const resumedModel = {
      ...host.provider!.config.models[0],
      name: "combo/coding",
      provider: "omniroute",
      api: "omniroute-openai-completions",
      baseUrl: "http://router.test/v1",
    };
    context.model = resumedModel;
    const events = host.provider!.config.streamSimple!(resumedModel as never, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response(": x-omniroute-model=vendor/resumed-route\n\ndata: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(context.model!.name).toBe("Coding Router▸vendor/resumed-route");
  });

  test("keeps a resolved combo without later routing metadata and accepts a new resolution", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);

    const stream = host.provider?.config.streamSimple;
    const routedModel = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-completions", baseUrl: "http://router.test/v1" } as never;
    const events = stream?.(
      routedModel,
      { messages: [] } as never,
      {
        apiKey: "secret",
        fetch: async () => new Response([
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"vendor/model-id","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
          "",
          ": x-omniroute-model=vendor/model-id",
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
      },
    );
    if (events) for await (const _event of events) { /* consume the provider stream */ }
    expect(context.model?.name).toBe("combo/coding▸vendor/model-id");

    const unresolvedEvents = stream?.(
      routedModel,
      { messages: [] } as never,
      {
        apiKey: "secret",
        fetch: async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }),
      },
    );
    if (unresolvedEvents) for await (const _event of unresolvedEvents) { /* consume the provider stream */ }
    expect(context.model?.name).toBe("combo/coding▸vendor/model-id");

    const reroutedEvents = stream?.(
      routedModel,
      { messages: [] } as never,
      {
        apiKey: "secret",
        fetch: async () => new Response(": x-omniroute-model=vendor/different-model\n\ndata: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      },
    );
    if (reroutedEvents) for await (const _event of reroutedEvents) { /* consume the provider stream */ }
    expect(context.model?.name).toBe("combo/coding▸vendor/different-model");
  });
  test("normalizes missing compatibility for the custom OMP API", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));
    const model: { id: string; name: string; compat?: Record<string, unknown> } = {
      id: host.provider!.config.models[0]!.id,
      name: "combo/coding",
      compat: undefined,
    };
    const context = fakeContext(model);

    host.emit("session_start", context);

    expect(model.compat).toEqual({});
  });
  test("uses owned_by metadata instead of model-id prefix for combo persistence", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "primary-auto", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "primary-auto", name: "primary-auto" });
    host.emit("session_start", context);
    const model = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-completions", baseUrl: "http://router.test/v1" } as never;
    const stream = host.provider!.config.streamSimple!;
    const run = async (body: string) => {
      const events = stream(model, { messages: [] } as never, {
        apiKey: "secret",
        fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      });
      for await (const _event of events) { /* consume the provider stream */ }
    };

    await run(": x-omniroute-model=vendor/first\n\ndata: [DONE]\n\n");
    expect(context.model?.name).toBe("primary-auto▸vendor/first");
    await run("data: [DONE]\n\n");
    expect(context.model?.name).toBe("primary-auto▸vendor/first");
  });

  test("suppresses the Chat Completions keepalive while forwarding real output", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-chat-keepalive-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: chat_completions\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo" }] }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);

    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-completions",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response([
        CHAT_KEEPALIVE_FRAME,
        "",
        'data: {"id":"1","object":"chat.completion.chunk","model":"vendor/model-id","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
    });

    const text: string[] = [];
    for await (const event of events as AsyncIterable<Record<string, unknown>>) {
      if (event.type === "text_delta" && typeof event.delta === "string") text.push(event.delta);
      if (event.type === "thinking_delta" && typeof event.delta === "string") text.push(event.delta);
    }

    expect(text.join("")).toBe("OK");
    expect(text.join("")).not.toContain("OmniRoute: got request");
    expect(context.model?.name).toBe("combo/coding▸vendor/model-id");
  });

  test("keeps a side request's routing off the main model's status line", async () => {
    // Title generation / auto thinking-level probes stream a different model
    // concurrently; their resolution must not retitle the session's model.
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }, { id: "cheap/titler" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);

    const stream = host.provider!.config.streamSimple!;
    const streamFor = async (id: string, routedModel: string) => {
      const model = {
        ...host.provider!.config.models.find(entry => entry.id === id)!,
        provider: "omniroute",
        api: "omniroute-openai-completions",
        baseUrl: "http://router.test/v1",
      } as never;
      const events = stream(model, { messages: [] } as never, {
        apiKey: "secret",
        fetch: async () => new Response(`: x-omniroute-model=${routedModel}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      });
      for await (const _event of events) { /* consume the provider stream */ }
    };

    await streamFor("combo/coding", "vendor/main-model");
    expect(context.model?.name).toBe("combo/coding▸vendor/main-model");

    await streamFor("cheap/titler", "vendor/tiny-model");
    expect(context.model?.name).toBe("combo/coding▸vendor/main-model");
  });

  test("keeps a direct model label plain even when the router reports another model", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "direct/model" }, { id: "combo/coding", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "direct/model", name: "direct/model" });
    host.emit("session_start", context);

    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-completions",
      baseUrl: "http://router.test/v1",
    } as never;
    const streamFor = async (body: string, headers: Record<string, string>) => {
      const events = host.provider?.config.streamSimple?.(
        model,
        { messages: [] } as never,
        {
          apiKey: "secret",
          fetch: async () => new Response(body, {
            headers: { "Content-Type": "text/event-stream", ...headers },
          }),
        },
      );
      if (events) for await (const _event of events) { /* consume the provider stream */ }
    };

    await streamFor(": x-omniroute-model=direct/model\n\ndata: [DONE]\n\n", {});
    expect(context.model?.name).toBe("direct/model");

    // A direct id is its own route: vendor aliasing in the trailer or the header
    // must never turn the status line into "requested▸routed".
    await streamFor(": x-omniroute-model=vendor/direct-model\n\ndata: [DONE]\n\n", {});
    expect(context.model?.name).toBe("direct/model");

    await streamFor("data: [DONE]\n\n", { "x-omniroute-model": "vendor/direct-model" });
    expect(context.model?.name).toBe("direct/model");
  });

  test("sends the selected reasoning effort to OmniRoute", async () => {
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{
        id: "combo/coding",
        owned_by: "combo",
        capabilities: { reasoning: true, effort_tiers: ["low", "medium", "high", "max"] },
      }],
    }));

    let requestBody: Record<string, unknown> | undefined;
    const stream = host.provider!.config.streamSimple!;
    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-responses",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = stream(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never, {
      apiKey: "secret",
      reasoning: "max",
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(requestBody?.reasoning).toMatchObject({ effort: "max" });
  });

  test("uses OMP's live thinking level when custom API options omit reasoning", async () => {
    const host = new FakeOmpHost();
    host.thinkingLevel = "high";
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [{ id: "any/model", capabilities: { reasoning: true } }],
    }));

    let requestBody: Record<string, unknown> | undefined;
    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-responses",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = host.provider!.config.streamSimple!(model, {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    } as never, {
      apiKey: "secret",
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("data: [DONE]\\n\\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(requestBody?.reasoning).toMatchObject({ effort: "high" });
  });

  test("injects the live effort into every discovered model payload after provider shaping", async () => {
    const host = new FakeOmpHost();
    host.thinkingLevel = "xhigh";
    await activateOmp(host, isolatedEnv(), async () => Response.json({
      data: [
        { id: "first/model" },
        { id: "second/model", capabilities: { reasoning: false } },
      ],
    }));
    const context = fakeContext({ id: "first/model", name: "first/model" });

    expect(await host.emitBeforeProviderRequest({ model: "first/model", messages: [] }, context)).toMatchObject({
      model: "first/model",
      reasoning: { effort: "xhigh" },
    });
    expect(await host.emitBeforeProviderRequest({ model: "second/model", messages: [] }, context)).toMatchObject({
      model: "second/model",
      reasoning: { effort: "xhigh" },
    });
  });

  test("continues startup without registering when discovery fails", async () => {
    const host = new FakeOmpHost();
    await activateOmp(
      host,
      isolatedEnv(),
      async () => new Response("unavailable", { status: 503 }),
    );
    expect(host.provider).toBeUndefined();
  });
  test("registers Responses through the custom stream and shapes reasoning", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-format-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    host.thinkingLevel = "high";
    await activateOmp(
      host,
      isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }),
      async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo", capabilities: { reasoning: true } }] }),
    );

    expect(host.provider?.config.api).toBe("omniroute-openai-responses");
    expect(host.provider?.config.streamSimple).toBeDefined();
    expect(await host.emitBeforeProviderRequest({ model: "combo/coding", input: [] }, fakeContext())).toMatchObject({
      model: "combo/coding",
      reasoning: { effort: "high" },
    });
  });
  test("adds live effort when Responses shaping already added a summary", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-effort-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    host.thinkingLevel = "high";
    await activateOmp(
      host,
      isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }),
      async () => Response.json({ data: [{ id: "combo/coding", capabilities: { reasoning: true } }] }),
    );

    expect(await host.emitBeforeProviderRequest({
      model: "combo/coding",
      input: [],
      reasoning: { summary: "auto" },
    }, fakeContext())).toMatchObject({
      reasoning: { effort: "high", summary: "auto" },
    });

    expect(await host.emitBeforeProviderRequest({
      model: "combo/coding",
      input: [],
      reasoning: { effort: "max", summary: "auto" },
    }, fakeContext())).toMatchObject({
      reasoning: { effort: "max", summary: "auto" },
    });
  });
  test("requests Responses reasoning summaries by default", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-summary-request-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({
      data: [{ id: "primary-auto", owned_by: "combo", capabilities: { reasoning: true } }],
    }));
    let requestBody: Record<string, any> | undefined;
    const model = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-responses", baseUrl: "http://router.test/v1" } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response('data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(requestBody?.reasoning?.summary).toBe("auto");
  });

  test("resolves the routed model from a Responses stream and drops keepalive frames", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-route-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);

    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-responses",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response([
        RESPONSES_KEEPALIVE_FRAME,
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1","model":"vendor/model-id"}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(context.model?.name).toBe("combo/coding▸vendor/model-id");
  });
  test("preserves real Responses reasoning summary events", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-reasoning-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo" }] }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);
    const model = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-responses", baseUrl: "http://router.test/v1" } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1","model":"vendor/model-id","status":"in_progress"}}',
        "",
        'event: response.output_item.added',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_real","type":"reasoning","summary":[]}}',
        "",
        'event: response.reasoning_summary_part.added',
        'data: {"type":"response.reasoning_summary_part.added","item_id":"rs_real","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}',
        "",
        'event: response.reasoning_summary_text.delta',
        'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_real","output_index":0,"summary_index":0,"delta":"Actual reasoning"}',
        "",
        'event: response.reasoning_summary_part.done',
        'data: {"type":"response.reasoning_summary_part.done","item_id":"rs_real","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"Actual reasoning"}}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"vendor/model-id","status":"completed","output":[]}}',
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
    });
    const thinking: string[] = [];
    for await (const event of events as AsyncIterable<Record<string, unknown>>) {
      if (event.type === "thinking_delta" && typeof event.delta === "string") thinking.push(event.delta);
    }

    expect(thinking.join(""), "real reasoning summary must survive placeholder filtering").toContain("Actual reasoning");
  });

  test("keeps updated route when Responses reports model only on completion", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-model-change-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);
    const model = {
      ...host.provider!.config.models[0],
      provider: "omniroute",
      api: "omniroute-openai-responses",
      baseUrl: "http://router.test/v1",
    } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"openai/gpt-5.2","status":"completed"}}',
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(context.model?.name).toBe("combo/coding▸openai/gpt-5.2");
  });

  test("keeps Responses route from final OmniRoute metadata trailer", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-trailer-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo" }] }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);
    const model = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-responses", baseUrl: "http://router.test/v1" } as never;
    const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
      apiKey: "secret",
      fetch: async () => new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
        "",
        ": x-omniroute-model=openai/gpt-5.2",
        "",
      ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }),
    });
    for await (const _event of events) { /* consume the provider stream */ }

    expect(context.model?.name).toBe("combo/coding▸openai/gpt-5.2");
  });
  test("uses response model header and keeps sticky combo route", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-omp-responses-header-route-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: responses\n");
    const host = new FakeOmpHost();
    await activateOmp(host, isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }), async () => Response.json({
      data: [{ id: "combo/coding", owned_by: "combo" }],
    }));
    const context = fakeContext({ id: "combo/coding", name: "combo/coding" });
    host.emit("session_start", context);
    const model = { ...host.provider!.config.models[0], provider: "omniroute", api: "omniroute-openai-responses", baseUrl: "http://router.test/v1" } as never;
    let requestCount = 0;
    const fetchResponse = async () => {
      requestCount++;
      return new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
        "",
      ].join("\n"), {
        headers: {
          "Content-Type": "text/event-stream",
          ...(requestCount === 1 ? { "X-OmniRoute-Model": "vendor/model-from-header" } : {}),
        },
      });
    };
    for (let i = 0; i < 2; i++) {
      const events = host.provider!.config.streamSimple!(model, { messages: [] } as never, {
        apiKey: "secret",
        fetch: fetchResponse,
      });
      for await (const _event of events) { /* consume the provider stream */ }
    }

    expect(context.model?.name).toBe("combo/coding▸vendor/model-from-header");
  });

});

describe("Pi adapter", () => {
  test("registers the shared discovered catalog with Pi metadata", async () => {
    const host = new FakePiHost();
    await activatePi(
      host,
      isolatedEnv({ OMNIROUTE_BASE_URL: "http://router.test" }),
      async () => Response.json({
        data: [{
          id: "combo/coding",
          owned_by: "combo",
          capabilities: { reasoning: true, effort_tiers: ["low", "medium", "high", "max"] },
        }],
      }),
    );

    expect(host.provider?.config.api).toBe("openai-responses");
    expect(host.provider?.config.models[0]).toMatchObject({
      id: "combo/coding",
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
    });
  });

  test("allows Chat Completions with Pi", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omniroute-pi-format-"));
    writeFileSync(join(agentDir, "omniroute.yml"), "format: chat_completions\n");
    const host = new FakePiHost();
    await activatePi(
      host,
      isolatedEnv({ PI_CODING_AGENT_DIR: agentDir }),
      async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo" }] }),
    );

    expect(host.provider?.config.api).toBe("openai-completions");
  });
});
