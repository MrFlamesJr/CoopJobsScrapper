CREATE TABLE IF NOT EXISTS scrape_runs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    search_url VARCHAR(500) NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    run_id BIGINT NOT NULL,
    page_number INT NOT NULL,
    title TEXT,
    employer TEXT,
    displayed_job_title TEXT,
    job_number VARCHAR(255),
    duration VARCHAR(255),
    work_model VARCHAR(255),
    term VARCHAR(255),
    deadline VARCHAR(255),
    round VARCHAR(255),
    salary VARCHAR(255),
    location TEXT,
    description LONGTEXT,
    qualifications LONGTEXT,
    requirements LONGTEXT,
    scraped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT jobs_run_id_fk FOREIGN KEY (run_id) REFERENCES scrape_runs(id)
);