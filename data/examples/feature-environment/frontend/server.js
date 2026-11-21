const http = require("node:http");

const html = `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Feature environment fixture</title>
  <h1>Feature environment fixture</h1>
  <pre id="api">Loading API...</pre>
  <pre id="socket">Connecting WebSocket...</pre>
  <script>
    fetch("/api/health").then((response) => response.json())
      .then((body) => { document.querySelector("#api").textContent = JSON.stringify(body); })
      .catch((error) => { document.querySelector("#api").textContent = error.message; });
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(scheme + "//" + location.host + "/api/ws");
    socket.addEventListener("message", (event) => {
      document.querySelector("#socket").textContent = event.data;
    });
    socket.addEventListener("error", () => {
      document.querySelector("#socket").textContent = "WebSocket failed";
    });
  </script>
</html>`;

http.createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
}).listen(3000, "0.0.0.0");
