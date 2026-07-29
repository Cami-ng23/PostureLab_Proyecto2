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
    app.run(debug=True)
