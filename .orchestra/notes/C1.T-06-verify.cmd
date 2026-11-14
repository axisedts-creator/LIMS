cd /d "%~dp0..\.." && python -B -m unittest discover -s infra/tests/static -p "test_t06_*.py" && python -B -m unittest discover -s infra/tests/integration -p "test_t07_*.py"
