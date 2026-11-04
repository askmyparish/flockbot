import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { afterAll, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

const network = new MockAgent();
network.disableNetConnect();
setGlobalDispatcher(network);
function blocked(): never {
  throw new Error("Unexpected network request in an offline test.");
}
for (const protocol of [http, https]) {
  vi.spyOn(protocol, "request").mockImplementation(blocked);
  vi.spyOn(protocol, "get").mockImplementation(blocked);
}
vi.spyOn(net, "connect").mockImplementation(blocked);
vi.spyOn(net, "createConnection").mockImplementation(blocked);
vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked);
vi.spyOn(tls, "connect").mockImplementation(blocked);
vi.spyOn(http2, "connect").mockImplementation(blocked);
syncBuiltinESMExports();
afterAll(async () => {
  await network.close();
});
