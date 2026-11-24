import socket
import threading
import sys

LOCAL_HOST = '127.0.0.1'
LOCAL_PORT = 8443
REMOTE_HOST = '100.82.8.12'
REMOTE_PORT = 8443

def forward(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            src.close()
        except Exception:
            pass
        try:
            dst.close()
        except Exception:
            pass

def handle_client(client_sock):
    try:
        remote_sock = socket.create_connection((REMOTE_HOST, REMOTE_PORT), timeout=10)
    except Exception as e:
        print(f"Failed to connect to {REMOTE_HOST}:{REMOTE_PORT}: {e}")
        client_sock.close()
        return

    t1 = threading.Thread(target=forward, args=(client_sock, remote_sock), daemon=True)
    t2 = threading.Thread(target=forward, args=(remote_sock, client_sock), daemon=True)
    t1.start()
    t2.start()

def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LOCAL_HOST, LOCAL_PORT))
    server.listen(10)
    print(f"Forwarding {LOCAL_HOST}:{LOCAL_PORT} -> {REMOTE_HOST}:{REMOTE_PORT}", flush=True)

    while True:
        client_sock, addr = server.accept()
        threading.Thread(target=handle_client, args=(client_sock,), daemon=True).start()

if __name__ == '__main__':
    main()
