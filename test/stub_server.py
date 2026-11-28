"""A stand-in for Lumate's connector routes, for smoke.sh.
Usage: stub_server.py PORT_FILE TOKEN QUESTIONS_FILE REQUESTS_FILE LOG_FILE [EXTRA_TOKENS_COMMA_SEPARATED [MODE_FILE]]
- GET  /api/connector/questions?format=text   the questions file
- GET  /api/connector/sessions/wait|requests   the requests file, once (then it is emptied); 204 when empty
- POST /api/connector/sessions/presence        logged
- POST /api/connector/sessions/main            logged; 404 for the session id 'unseen'
- POST /api/connector/link                     answers a .lumate.env text for the code 'goodcode'; 404 otherwise
Every request is appended to LOG_FILE as `METHOD PATH TOKEN BODY` (the token as sent, so a test can see which key a session used)."""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKENS = {sys.argv[2], *[t for t in (sys.argv[6].split(",") if len(sys.argv) > 6 else []) if t]}
QUESTIONS, REQUESTS, LOG = sys.argv[3], sys.argv[4], sys.argv[5]
MODE = sys.argv[7] if len(sys.argv) > 7 else ""   # optional: a file whose first line is an HTTP status that every sessions/wait call answers with (e.g. 503)
ANSWERED = sys.argv[8] if len(sys.argv) > 8 else ""   # optional: a file with the ids (one per line) of requests the server accepted a reply for
ENV_TEXT = "LUMATE_URL=http://127.0.0.1:1\nLUMATE_TOKEN=lmt_from-the-link-endpoint\nLUMATE_PROJECT=ACM-1\n"


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body=b"", kind="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def note(self, body=""):
        auth = self.headers.get("Authorization", "")
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(f"{self.command} {self.path} {auth.removeprefix('Bearer ')} {body}\n")
        return auth.removeprefix("Bearer ") in TOKENS

    def do_GET(self):
        authed = self.note()
        if not authed:
            return self.reply(401, b'{"detail":"bad"}')
        if self.path.startswith("/api/connector/questions"):
            return self.reply(200, open(QUESTIONS, encoding="utf-8").read().encode())
        if self.path.startswith("/api/connector/sessions/request-state"):
            rid = self.path.split("request_id=")[-1]
            done = open(ANSWERED, encoding="utf-8").read().split() if ANSWERED else []
            return self.reply(200, b"answered" if rid in done else b"open")
        if self.path.startswith(("/api/connector/sessions/wait", "/api/connector/sessions/requests")):
            if MODE and self.path.startswith("/api/connector/sessions/wait"):
                try:
                    forced = open(MODE, encoding="utf-8").read().strip()
                except OSError:
                    forced = ""
                if forced.isdigit():
                    return self.reply(int(forced), b"{}")
            text = open(REQUESTS, encoding="utf-8").read()
            if not text.strip():
                return self.reply(204)
            open(REQUESTS, "w").close()  # delivered once
            return self.reply(200, text.encode())
        return self.reply(200, b"{}", "application/json")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        authed = self.note(body.replace("\n", " "))
        if self.path == "/api/connector/link":
            if "code=badshape" in body:
                return self.reply(201, (ENV_TEXT + "EXTRA=1\n").encode())
            if "code=bigbody" in body:
                return self.reply(201, b"x" * 6000)
            return self.reply(201, ENV_TEXT.encode()) if "code=goodcode" in body else self.reply(404, b"no")
        if self.path == "/api/connector/sessions/presence":
            return self.reply(200, b'{"ok":true}', "application/json") if authed else self.reply(401, b"{}")
        if self.path == "/api/connector/sessions/main":
            if not authed:
                return self.reply(401, b"{}")
            return self.reply(404, b'{"detail":"not seen"}', "application/json") if '"session_id":"unseen"' in body else self.reply(200, b'{"ok":true}', "application/json")
        return self.reply(404)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as handle:
    handle.write(str(server.server_port))
server.serve_forever()
