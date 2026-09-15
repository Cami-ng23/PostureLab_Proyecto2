import os

from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def home():
    # Por ahora la home ES el simulador. Cuando agregues login/dashboard
    # (según tu documento, con SQLite para las evaluaciones), esta ruta
    # pasará a ser el dashboard y el simulador se mueve a /simulador.
    return render_template("simulador.html")


@app.route("/simulador")
def simulador():
    return render_template("simulador.html")


if __name__ == "__main__":
    # host=0.0.0.0 y el puerto por variable de entorno: así funciona igual
    # en tu compu (localhost:5000) y en Railway/Render (que inyectan PORT).
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
