const http = require("node:http");
const crypto = require("node:crypto");

const server = http.createServer((request, response) => {
  if (request.url !== "/api/health") {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, service: "api" }));
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/api/ws" || !request.headers["sec-websocket-key"]) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
  const message = Buffer.from("same-origin websocket reached API");
  socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  socket.end();
});

server.listen(3001, "0.0.0.0");
