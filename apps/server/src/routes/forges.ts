import {
  ForgejoConnectionRequest,
  ForgejoTestRequest,
  type ForgesResponse,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

/**
 * `/api/forges`: the Forgejo connection (`docs/forges.md` §6.1). Status responses never carry
 * the token: it is write-only (the `PUT` body's `token`) and kept in the OS keychain.
 */
export function forgeRoutes(s: AppServices) {
  return new Hono()
    .get("/", async (c) => {
      const forges: ForgesResponse["forges"] = [await s.forgejo.status()];
      return c.json<ForgesResponse>({ forges });
    })
    .put("/forgejo", jsonBody(ForgejoConnectionRequest), async (c) =>
      c.json(await s.forgejo.configure(c.req.valid("json"))),
    )
    .post("/forgejo/test", jsonBody(ForgejoTestRequest), async (c) =>
      c.json(await s.forgejo.test(c.req.valid("json"))),
    )
    .delete("/forgejo", async (c) => c.json(await s.forgejo.remove()));
}
