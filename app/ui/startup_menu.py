class StartupMenu:
    """Show startup actions and return the selected action name."""

    def __init__(self, database, input_func=input, output_func=print):
        self.database = database
        self.input_func = input_func
        self.output_func = output_func

    def choose_action(self):
        if not self.database.exists():
            return self._ask(
                "No database was found. It will be created automatically.",
                {"1": ("Scrape", "scrape")},
            )

        self.database.ensure()
        if not self.database.has_jobs():
            return self._ask(
                "The database is empty.",
                {"1": ("Scrape", "scrape")},
            )

        return self._ask(
            "The database already contains jobs. Scraping again will delete and replace all existing data.",
            {
                "1": ("Delete the database and scrape again", "reset_and_scrape"),
                "2": ("Open the jobs web app", "open_web_app"),
            },
        )

    def _confirm_overwrite(self):
        while True:
            answer = self.input_func("Are you sure you want to delete the database and scrape again? (y/n): ").strip().lower()
            if answer in {"y", "yes"}:
                return "reset_and_scrape"
            if answer in {"n", "no"}:
                return "cancel"
            self.output_func("Please answer y or n.")

    def _ask(self, message, options):
        self.output_func(message)
        for number, (label, _) in options.items():
            self.output_func(f"{number}. {label}")

        while True:
            choice = self.input_func("Choose an option: ").strip()
            if choice in options:
                action = options[choice][1]
                if action == "reset_and_scrape":
                    return self._confirm_overwrite()
                return action
            self.output_func("Please choose one of the listed options.")