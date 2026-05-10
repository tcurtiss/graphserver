from flask import Blueprint, send_from_directory
import os

frontend_bp = Blueprint("frontend", __name__)


@frontend_bp.route("/")
def index():
    static_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "static"))
    return send_from_directory(static_dir, "index.html")
