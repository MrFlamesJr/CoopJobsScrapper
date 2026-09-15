from pathlib import Path

import mysql.connector


class MySQLDatabase:
    """Create, inspect, and reset the scraper database."""

    def __init__(self, host, port, database, user, password, schema_path):
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.schema_path = Path(schema_path)

    def exists(self):
        connection = self._connect_to_server()
        cursor = connection.cursor()
        try:
            cursor.execute("SHOW DATABASES LIKE %s", (self.database,))
            return cursor.fetchone() is not None
        finally:
            cursor.close()
            connection.close()

    def ensure(self):
        connection = self._connect_to_server()
        cursor = connection.cursor()
        try:
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{self._safe_database_name()}`")
            connection.commit()
        finally:
            cursor.close()
            connection.close()

        connection = self._connect_to_database()
        cursor = connection.cursor()
        try:
            schema = self.schema_path.read_text(encoding="utf-8")
            for statement in schema.split(";"):
                statement = statement.strip()
                if statement:
                    cursor.execute(statement)
            connection.commit()
        finally:
            cursor.close()
            connection.close()

    def has_jobs(self):
        connection = self._connect_to_database()
        cursor = connection.cursor()
        try:
            cursor.execute("SELECT COUNT(*) FROM jobs")
            return cursor.fetchone()[0] > 0
        finally:
            cursor.close()
            connection.close()

    def delete(self):
        connection = self._connect_to_server()
        cursor = connection.cursor()
        try:
            cursor.execute(f"DROP DATABASE IF EXISTS `{self._safe_database_name()}`")
            connection.commit()
        finally:
            cursor.close()
            connection.close()

    def _connect_to_server(self):
        return mysql.connector.connect(
            host=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
        )

    def _connect_to_database(self):
        return mysql.connector.connect(
            host=self.host,
            port=self.port,
            database=self.database,
            user=self.user,
            password=self.password,
        )

    def _safe_database_name(self):
        if not self.database.replace("_", "").isalnum():
            raise ValueError("MYSQL_DATABASE may only contain letters, numbers, and underscores.")
        return self.database