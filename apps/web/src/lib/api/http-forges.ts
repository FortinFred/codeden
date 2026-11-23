import { ForgeConnectionStatus, ForgesResponse } from "@codeden/contracts";
import type { ForgesApi } from "./feature-apis";
import type { Fetcher } from "./http";

/** `/api/forges`: the Forgejo connection status, save, test and remove (`docs/forges.md` §6.1). */
export function httpForgesApi(http: Fetcher): ForgesApi {
  return {
    list: () => http.get("/forges", (v) => ForgesResponse.parse(v)),
    saveForgejo: (req) =>
      http.call("PUT", "/forges/forgejo", req, (v) => ForgeConnectionStatus.parse(v)),
    testForgejo: (req = {}) =>
      http.post("/forges/forgejo/test", req, (v) => ForgeConnectionStatus.parse(v)),
    removeForgejo: () =>
      http.call("DELETE", "/forges/forgejo", undefined, (v) => ForgeConnectionStatus.parse(v)),
  };
}
