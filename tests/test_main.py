import socket

from app.__main__ import _port_in_use


def test_port_in_use_detects_listening_socket():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    try:
        assert _port_in_use(port) is True
    finally:
        listener.close()


def test_port_in_use_false_when_nothing_listening():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()  # free the port before checking

    assert _port_in_use(port) is False
