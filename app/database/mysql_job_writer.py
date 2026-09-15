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
            charset="utf8mb4",
            collation="utf8mb4_unicode_ci",
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
        job_query = """
            INSERT INTO jobs (
                run_id, page_number, title, employer, displayed_job_title,
                job_number, duration, work_model, term, deadline, round, salary,
                location, description
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        requirement_query = """
            INSERT INTO job_requirements (job_id, requirement_order, requirement)
            VALUES (%s, %s, %s)
        """
        qualification_query = """
            INSERT INTO job_qualifications (
                job_id, qualification_order, qualification_name, qualification_value
            ) VALUES (%s, %s, %s, %s)
        """
        cursor = self.connection.cursor()
        try:
            for job in jobs:
                cursor.execute(
                    job_query,
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
                    ),
                )
                job_id = cursor.lastrowid
                cursor.executemany(
                    requirement_query,
                    [
                        (job_id, requirement_order, requirement)
                        for requirement_order, requirement in enumerate(
                            self._clean_list(job.get("requirements", [])), start=1
                        )
                    ],
                )
                cursor.executemany(
                    qualification_query,
                    [
                        (job_id, qualification_order, qualification["name"], qualification["value"])
                        for qualification_order, qualification in enumerate(
                            job.get("qualifications", []), start=1
                        )
                    ],
                )
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise
        finally:
            cursor.close()

    @staticmethod
    def _clean_list(values):
        return [value.strip() for value in values if value and value.strip()]

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
