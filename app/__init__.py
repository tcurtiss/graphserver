from flask import Flask
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

from app.config import Config
from app.db import init_driver
from app.routes.api import api_bp
from app.routes.frontend import frontend_bp


def create_app():
    app = Flask(
        __name__,
        static_folder="static",
        static_url_path="/static",
    )
    app.config.from_object(Config)
    CORS(app)

    init_driver(app)

    app.register_blueprint(api_bp, url_prefix="/api")
    app.register_blueprint(frontend_bp)

    return app
