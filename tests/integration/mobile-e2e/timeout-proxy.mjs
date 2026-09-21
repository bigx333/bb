import http from "node:http";
import net from "node:net";

let failing = false;
const proxy = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method === "POST" && pathname === "/__timeout/fail") {
    failing = true;
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && pathname === "/__timeout/recover") {
    failing = false;
    response.writeHead(204).end();
    return;
  }
  if (failing && (pathname === "/" || pathname === "/threads")) {
    console.log(JSON.stringify({ event: "injected-504", path: pathname }));
    response.writeHead(504, { "content-type": "text/plain" });
    response.end("bb connect: timed out waiting for the tunnel client\n");
    return;
  }
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: 41999,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: "127.0.0.1:41999" },
    },
    (incoming) => {
      console.log(JSON.stringify({ event: "response", path: pathname, status: incoming.statusCode }));
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    console.error(error.message);
    response.writeHead(502).end();
  });
  request.pipe(upstream);
});

proxy.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(41999, "127.0.0.1", () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
    }
    upstream.write("\r\n");
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});

proxy.listen(41998, "127.0.0.1", () => console.log("timeout proxy ready"));
