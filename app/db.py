from neo4j import GraphDatabase
import atexit

_driver = None


def init_driver(app):
    global _driver
    _driver = GraphDatabase.driver(
        app.config["NEO4J_URI"],
        auth=(app.config["NEO4J_USER"], app.config["NEO4J_PASSWORD"]),
    )
    _driver.verify_connectivity()
    atexit.register(lambda: _driver.close())


def get_driver():
    return _driver


def run_query(cypher, params=None):
    with _driver.session() as session:
        result = session.run(cypher, params or {})
        return [record.data() for record in result]
