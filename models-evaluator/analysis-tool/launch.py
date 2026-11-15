import argparse
import http.server
import socketserver
import os
import sys
import signal

DEFAULT_PORT = 12131
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

parser = argparse.ArgumentParser(description="Launch analysis tool web server.")
parser.add_argument(
    "csv_file",
    nargs="?",
    default=None,
    help="Path to CSV file (optional).",
)
parser.add_argument(
    "port_pos",
    nargs="?",
    default=None,
    help=f"Port to bind the server to (optional positional, default: {DEFAULT_PORT}).",
)
parser.add_argument(
    "--port", "-p",
    type=int,
    default=None,
    help=f"Port to bind the server to (default: {DEFAULT_PORT}).",
)

args = parser.parse_args()

PORT = args.port
csv_path = None

positional = [a for a in [args.csv_file, args.port_pos] if a is not None]
for a in positional:
    if a.isdigit():
        if PORT is None:
            PORT = int(a)
    elif csv_path is None:
        csv_path = a

if PORT is None:
    PORT = DEFAULT_PORT

if not (1 <= PORT <= 65535):
    print(f"Error: Invalid port number {PORT}. Must be between 1 and 65535.", file=sys.stderr)
    sys.exit(1)

CSV_FILE = None
if csv_path:
    resolved_path = os.path.abspath(csv_path)
    if csv_path.endswith('.csv') or os.path.isfile(resolved_path):
        CSV_FILE = resolved_path

# Global server reference for signal handler
httpd = None

def signal_handler(signum, frame):
    """Handle Ctrl+C gracefully"""
    global httpd
    print("\n\nReceived Ctrl+C. Shutting down server...")
    if httpd:
        httpd.shutdown()
    sys.exit(0)

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path == '/default.csv' and CSV_FILE:
            try:
                with open(CSV_FILE, 'rb') as f:
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
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as server:
        httpd = server
        # Register signal handler for Ctrl+C
        signal.signal(signal.SIGINT, signal_handler)
        print(f"Server launched successfully.")
        if CSV_FILE:
            print(f"Serving default CSV: {CSV_FILE}")
        print(f"Open your browser and navigate to: http://localhost:{PORT}")
        print("Press Ctrl+C to stop the server.\n")
        try:
            httpd.serve_forever()
        except Exception as e:
            print(f"Error: {e}")
            sys.exit(1)
