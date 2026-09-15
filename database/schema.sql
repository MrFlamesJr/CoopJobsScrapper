CREATE TABLE IF NOT EXISTS scrape_runs (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    search_url VARCHAR(500) NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
    scraped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT jobs_run_id_fk FOREIGN KEY (run_id) REFERENCES scrape_runs(id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_qualifications (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_id BIGINT NOT NULL,
    qualification_order INT NOT NULL,
    qualification_name TEXT NOT NULL,
    qualification_value TEXT NULL,
    CONSTRAINT job_qualifications_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    CONSTRAINT job_qualifications_order_unique UNIQUE (job_id, qualification_order)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_requirements (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    job_id BIGINT NOT NULL,
    requirement_order INT NOT NULL,
    requirement TEXT NOT NULL,
    CONSTRAINT job_requirements_job_id_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    CONSTRAINT job_requirements_order_unique UNIQUE (job_id, requirement_order)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;