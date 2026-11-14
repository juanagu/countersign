from evals.thresholds import load_thresholds


def test_backup_mode_lowers_only_the_quality_judge() -> None:
    primary = load_thresholds()
    backup = primary.for_backup()

    assert backup.judge_averages["judge_quality"] < primary.judge_averages["judge_quality"]
    assert backup.judge_averages["judge_citation"] == primary.judge_averages["judge_citation"]
    assert backup.pass_rates == primary.pass_rates
