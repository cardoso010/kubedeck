import { describe, expect, it } from "vitest";
import { age, formatCpu, formatMemory, formatRate, isProduction, isUnauthorized, shortContextName, splitChart } from "./api";

describe("isProduction", () => {
  // The guard behind the type-to-confirm dialogs and the read-only default: it must not miss.
  it.each(["shop-prd", "prod", "eu-production-1", "arn:aws:eks:us-east-1:123:cluster/shop-prd", "gke_proj_zone_prod.main", "PRD"])("treats %s as production", (ctx) => {
    expect(isProduction(ctx)).toBe(true);
  });
  it.each(["kind-kubedeck-test", "staging", "product-catalog-dev", "preprod2"])("does not treat %s as production", (ctx) => {
    expect(isProduction(ctx)).toBe(false);
  });
});

describe("shortContextName", () => {
  it("shortens EKS ARNs and GKE contexts", () => {
    expect(shortContextName("arn:aws:eks:us-east-1:123456789012:cluster/shop-prd")).toBe("shop-prd");
    expect(shortContextName("gke_my-project_europe-west1_payments")).toBe("payments");
    expect(shortContextName("kind-kubedeck-test")).toBe("kind-kubedeck-test");
  });
});

describe("isUnauthorized", () => {
  it("matches the backend's 401 wording only", () => {
    expect(isUnauthorized("demo: Unauthorized (401): the cluster rejected your credentials.")).toBe(true);
    expect(isUnauthorized("pods is forbidden (403)")).toBe(false);
  });
});

describe("splitChart", () => {
  it("splits name and version, including names with dashes and prereleases", () => {
    expect(splitChart("ingress-nginx-4.11.3")).toEqual({ name: "ingress-nginx", version: "4.11.3" });
    expect(splitChart("app-1.0.0-rc.1")).toEqual({ name: "app", version: "1.0.0-rc.1" });
    expect(splitChart("local")).toEqual({ name: "local", version: null });
  });
});

describe("formatting", () => {
  it("formats CPU, memory and rates", () => {
    expect(formatCpu(250)).toBe("250m");
    expect(formatCpu(1500)).toBe("1.50");
    expect(formatMemory(64 * 1024 * 1024)).toBe("64Mi");
    expect(formatMemory(3 * 1024 ** 3)).toBe("3.00Gi");
    expect(formatRate(512)).toBe("512 B/s");
    expect(formatRate(2048)).toBe("2.0 KiB/s");
  });

  it("formats ages", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(age(null, now)).toBe("");
    expect(age("2026-11-13T11:59:30Z", now)).toBe("30s");
    expect(age("2026-11-13T11:00:00Z", now)).toBe("60m");
    expect(age("2026-11-12T12:00:00Z", now)).toBe("24h");
    expect(age("2026-11-01T12:00:00Z", now)).toBe("12d");
    expect(age("2026-11-13T12:00:10Z", now)).toBe("0s");
  });
});
