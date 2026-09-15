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
            "The database already contains jobs.",
            {
                "1": ("Scrape", "scrape"),
                "2": ("Placeholder", "placeholder"),
            },
        )

    def _ask(self, message, options):
        self.output_func(message)
        for number, (label, _) in options.items():
            self.output_func(f"{number}. {label}")

        while True:
            choice = self.input_func("Choose an option: ").strip()
            if choice in options:
                return options[choice][1]
            self.output_func("Please choose one of the listed options.")