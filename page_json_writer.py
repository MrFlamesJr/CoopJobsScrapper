import logging

import mysql.connector


class MySQLJobWriter:
    """Save one scraper run and its jobs in MySQL."""

    def __init__(self, host, port, database, user, password, search_url):
        self.logger = logging.getLogger(__name__)
        self.connection = mysql.connector.connect(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
        )
        self.run_id = self._create_run(search_url)

    def _create_run(self, search_url):
        cursor = self.connection.cursor()
        try:
            cursor.execute(
                "INSERT INTO scrape_runs (search_url) VALUES (%s)",
                (search_url,),
            )
            self.connection.commit()
            return cursor.lastrowid
        finally:
            cursor.close()

    def append_page(self, jobs, page_number):
        query = """
            INSERT INTO jobs (
                run_id, page_number, title, employer, displayed_job_title,
                job_number, duration, work_model, term, deadline, round, salary,
                location, description, qualifications, requirements
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        values = [
            (
                self.run_id,
                page_number,
                job.get("title", ""),
                job.get("employer", ""),
                job.get("displayed_job_title", ""),
                job.get("metadata", {}).get("Job number", ""),
                job.get("metadata", {}).get("Duration", ""),
                job.get("metadata", {}).get("Work model", ""),
                job.get("metadata", {}).get("Term", ""),
                job.get("metadata", {}).get("Deadline", ""),
                job.get("metadata", {}).get("Round", ""),
                job.get("metadata", {}).get("Salary", ""),
                job.get("location", ""),
                job.get("description", ""),
                job.get("qualifications", ""),
                "\n".join(job.get("requirements", [])),
            )
            for job in jobs
        ]
        cursor = self.connection.cursor()
        try:
            cursor.executemany(query, values)
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        finally:
            cursor.close()

    def close(self, completed=False):
        if not self.connection.is_connected():
            return

        cursor = self.connection.cursor()
        try:
            if completed:
                cursor.execute(
                    "UPDATE scrape_runs SET completed_at = CURRENT_TIMESTAMP WHERE id = %s",
                    (self.run_id,),
                )
                self.connection.commit()
        finally:
            cursor.close()
            self.connection.close()
