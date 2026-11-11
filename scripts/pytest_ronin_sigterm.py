"""Plugin de pytest que carga unit-gate.sh: SIGTERM → KeyboardInterrupt.

Ronin corta un gate con SIGTERM al grupo y espera un plazo de gracia antes del SIGKILL. Python
muere con SIGTERM sin correr `finally` ni el teardown de los fixtures (p.ej. los contenedores
postgres de docker_pg quedaban vivos). Con KeyboardInterrupt pytest sí cierra la sesión y finaliza
los fixtures. Un segundo SIGTERM se ignora para no cortar ese teardown a la mitad.
"""
import signal


def _terminar(signum, frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise KeyboardInterrupt(f"señal {signum}: cortando la suite para correr el teardown")


def pytest_configure(config):
    signal.signal(signal.SIGTERM, _terminar)
