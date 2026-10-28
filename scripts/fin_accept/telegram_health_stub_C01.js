const http = require("http");
const port = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    if (req.url === "/fail-health") {
      res.writeHead(500);
      return res.end("fail");
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  })
  .listen(port, "0.0.0.0");
