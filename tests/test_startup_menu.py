from app.ui.startup_menu import StartupMenu


class FakeDatabase:
    def __init__(self, *, exists=True, has_jobs=True):
        self._exists = exists
        self._has_jobs = has_jobs

    def exists(self):
        return self._exists

    def ensure(self):
        return None

    def has_jobs(self):
        return self._has_jobs


def test_populated_database_requires_explicit_overwrite_confirmation():
    outputs = []
    prompts = []
    responses = iter(["1", "y"])

    menu = StartupMenu(
        FakeDatabase(exists=True, has_jobs=True),
        input_func=lambda prompt: (prompts.append(prompt), next(responses))[1],
        output_func=lambda message: outputs.append(message),
    )

    action = menu.choose_action()

    assert action == "reset_and_scrape"
    assert any("delete the database and scrape again" in message.lower() for message in outputs)
    assert any("are you sure" in prompt.lower() for prompt in prompts)


def test_empty_database_skips_overwrite_prompt():
    outputs = []

    menu = StartupMenu(
        FakeDatabase(exists=True, has_jobs=False),
        input_func=lambda prompt: "1",
        output_func=lambda message: outputs.append(message),
    )

    assert menu.choose_action() == "scrape"
    assert not any("are you sure" in message.lower() for message in outputs)


def test_populated_database_can_open_the_jobs_web_app():
    menu = StartupMenu(
        FakeDatabase(exists=True, has_jobs=True),
        input_func=lambda prompt: "2",
        output_func=lambda message: None,
    )

    assert menu.choose_action() == "open_web_app"
