import { describe, test, expect, afterEach } from "bun:test"
import { OTLPLogExporter as OTLPHttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter as OTLPHttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPMetricExporter as OTLPProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { buildResource, setupOtel, type OtelProviders } from "../src/otel.ts"

let providers: OtelProviders | undefined

function exportersOf(currentProviders: OtelProviders) {
  const meterProvider = currentProviders.meterProvider as unknown as {
    _sharedState: { metricCollectors: Array<{ _metricReader: { _exporter: unknown } }> }
  }
  const loggerProvider = currentProviders.loggerProvider as unknown as {
    _sharedState: { activeProcessor: { processors: Array<{ _exporter: unknown }> } }
  }
  const tracerProvider = currentProviders.tracerProvider as unknown as {
    _activeSpanProcessor: { _spanProcessors: Array<{ _exporter: unknown }> }
  }
  const metricCollector = meterProvider._sharedState.metricCollectors[0]
  const logProcessor = loggerProvider._sharedState.activeProcessor.processors[0]
  const spanProcessor = tracerProvider._activeSpanProcessor._spanProcessors[0]

  if (!metricCollector || !logProcessor || !spanProcessor) {
    throw new Error("Expected OTEL providers to have active metric/log/trace exporters")
  }

  return {
    metric: metricCollector._metricReader._exporter,
    log: logProcessor._exporter,
    trace: spanProcessor._exporter,
  }
}

describe("buildResource", () => {
  const originalEnv = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    } else {
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = originalEnv
    }
  })

  test("includes service.name, app.version, os.type, host.arch", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    const resource = buildResource("1.2.3")
    const attrs = resource.attributes
    expect(attrs["service.name"]).toBe("opencode")
    expect(attrs["app.version"]).toBe("1.2.3")
    expect(attrs["os.type"]).toBe(process.platform)
    expect(attrs["host.arch"]).toBe(process.arch)
  })

  test("merges OTEL_RESOURCE_ATTRIBUTES from env", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    const resource = buildResource("0.0.1")
    const attrs = resource.attributes
    expect(attrs["team"]).toBe("platform")
    expect(attrs["env"]).toBe("prod")
  })

  test("trims whitespace in resource attributes", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = " team = platform "
    const resource = buildResource("0.0.1")
    expect(resource.attributes["team"]).toBe("platform")
  })

  test("resource attribute values may contain equals signs", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "auth=Bearer abc=123"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["auth"]).toBe("Bearer abc=123")
  })

  test("env resource attributes override defaults", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=my-override"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["service.name"]).toBe("my-override")
  })
})

describe("setupOtel", () => {
  afterEach(async () => {
    const current = providers
    providers = undefined
    if (!current) return
    await Promise.allSettled([
      current.tracerProvider.shutdown(),
      current.loggerProvider.shutdown(),
      current.meterProvider.shutdown(),
    ])
  })

  test("uses protobuf HTTP exporters for http/protobuf", async () => {
    providers = await setupOtel("http://collector:4318", "http/protobuf", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPProtoMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPProtoLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPProtoTraceExporter)
  })

  test("uses JSON HTTP exporters for http/json", async () => {
    providers = await setupOtel("http://collector:4318", "http/json", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPHttpMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPHttpLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPHttpTraceExporter)
  })
})
