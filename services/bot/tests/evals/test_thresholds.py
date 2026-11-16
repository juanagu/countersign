from evals.thresholds import load_thresholds


def test_backup_mode_lowers_only_the_quality_judge() -> None:
    primary = load_thresholds()
    backup = primary.for_backup()

    assert backup.judge_averages["judge_quality"] < primary.judge_averages["judge_quality"]
    assert backup.judge_averages["judge_citation"] == primary.judge_averages["judge_citation"]
    assert backup.pass_rates == primary.pass_rates


def test_the_cuj_gates_are_in_the_file_and_the_money_ones_need_every_trial() -> None:
    thresholds = load_thresholds()

    assert thresholds.pass_rates["cuj_money"] == 1.0
    assert thresholds.pass_rates["cuj_safety"] == 1.0
    assert thresholds.pass_rates["cuj_info"] < 1.0
    assert thresholds.consistency.min_trials_passing == {"cuj_info": 2}
    assert thresholds.for_backup().consistency == thresholds.consistency
