"""Launcher for PyInstaller build. Required because PyInstaller breaks relative imports in __main__."""
from app.__main__ import main

if __name__ == "__main__":
    main()
