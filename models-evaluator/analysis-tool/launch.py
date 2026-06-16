import http.server
import socketserver
import os
import sys

PORT = 12144
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

DEFAULT_CSV = None
if len(sys.argv) > 1 and sys.argv[1].endswith('.csv'):
    DEFAULT_CSV = os.path.abspath(sys.argv[1])

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path == '/default.csv' and DEFAULT_CSV:
            try:
                with open(DEFAULT_CSV, 'rb') as f:
                    self.send_response(200)
                    self.send_header('Content-type', 'text/csv')
                    self.end_headers()
                    self.wfile.write(f.read())
                    return
            except FileNotFoundError:
                self.send_error(404, "File not found")
                return
        
        super().do_GET()

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Server launched successfully.")
        if DEFAULT_CSV:
            print(f"Serving default CSV: {DEFAULT_CSV}")
        print(f"Open your browser and navigate to: http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
