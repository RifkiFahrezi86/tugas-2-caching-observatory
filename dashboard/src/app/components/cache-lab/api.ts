import type {
  CatalogResponse,
  RunResponse,
  ScenarioSelection,
  StatusPayload,
} from "./types";

async function readError(response: Response) {
  const fallback = `HTTP ${response.status}`;
  const contentType = response.headers.get("content-type") || "";

  try {
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      return payload.error || payload.message || fallback;
    }

    const text = await response.text();
    return text || fallback;
  } catch {
    return fallback;
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as T;
}

export function fetchCatalog() {
  return requestJson<CatalogResponse>("/api/catalog");
}

export function fetchStatus() {
  return requestJson<StatusPayload>("/api/status");
}

export function resetSimulation() {
  return requestJson<StatusPayload>("/api/reset", { method: "POST" });
}

export function runSimulation(selection: ScenarioSelection) {
  return requestJson<RunResponse>("/api/simulations/run", {
    method: "POST",
    body: JSON.stringify(selection),
  });
}
