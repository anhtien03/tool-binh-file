"""Toolbinhfile Desktop Launcher (PyWebView + Offline Embedded Local Server + Adobe-style Splash)."""
import functools
import http.server
import mimetypes
import os
import socketserver
import sys
import threading
import webview

# Ensure proper MIME types on Windows (especially .mjs for pdf.worker.mjs & ES modules)
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".bcmap")
mimetypes.add_type("image/svg+xml", ".svg")


def update_splash(message: str):
    try:
        import pyi_splash  # type: ignore
        pyi_splash.update_text(message)
    except Exception:
        pass


def close_splash():
    try:
        import pyi_splash  # type: ignore
        pyi_splash.close()
    except Exception:
        pass


def resolve_web_dist() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, "web_dist")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "web_dist")


class QuietSPAHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress console HTTP logs

    def end_headers(self):
        # Allow local worker & clean caching inside embedded WebView2
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_local_server(web_dir: str):
    handler = functools.partial(QuietSPAHandler, directory=web_dir)
    server = ThreadedHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def main():
    update_splash("Đang nạp dữ liệu giao diện & bộ từ điển font PDF...")
    web_dir = resolve_web_dist()
    if not os.path.isdir(web_dir):
        close_splash()
        raise RuntimeError(f"Không tìm thấy thư mục giao diện: {web_dir}")

    server, port = start_local_server(web_dir)
    url = f"http://127.0.0.1:{port}/index.html"

    # Enable native Windows Save-As downloads for exported PDF/SVG files
    webview.settings["ALLOW_DOWNLOADS"] = True

    update_splash("Đang khởi chạy cửa sổ Toolbinhfile Pro...")
    window = webview.create_window(
        title="Toolbinhfile Pro — Bình Bài In, Tem Bế & Khuôn Bế 3D",
        url=url,
        width=1400,
        height=880,
        min_size=(1024, 680),
        background_color="#112A24",
    )

    def on_loaded():
        close_splash()

    window.events.loaded += on_loaded

    try:
        webview.start(gui="edgechromium", debug=False)
    finally:
        close_splash()
        server.shutdown()


if __name__ == "__main__":
    main()
