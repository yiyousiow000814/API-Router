#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::GATEWAY_MODEL_PROVIDER_ID;

    #[test]
    fn switchboard_base_cfg_path_is_under_app_dir_even_with_absolute_home() {
        let (config_path, cli_home) = if cfg!(windows) {
            (
                PathBuf::from(r"C:\Temp\user-data\config.toml"),
                PathBuf::from(r"C:\Users\user\.codex"),
            )
        } else {
            (
                PathBuf::from("/tmp/user-data/config.toml"),
                PathBuf::from("/home/user/.codex"),
            )
        };
        let p = switchboard_base_cfg_path_from_config_path(&config_path, &cli_home);
        let base_dir = switchboard_base_dir_from_config_path(&config_path);
        assert!(
            p.starts_with(&base_dir),
            "path should stay under provider-switchboard-base; got: {}",
            p.display()
        );
    }

    #[test]
    fn read_cfg_base_text_prefers_gateway_edits_made_after_restore() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();

        // This is the gateway config after restore.
        let gateway_cfg = "model = \"gpt-5.2\"\n[notice]\nhide_full_access_warning = true\n";
        std::fs::write(cli_cfg_path(&cli_home), gateway_cfg).unwrap();

        // Saved base config from a prior swapped session.
        let saved_base = "model = \"gpt-5.3-codex\"\n[notice]\nhide_full_access_warning = true\n";
        save_switchboard_base_cfg(&config_path, &cli_home, saved_base).expect("save base");

        // Baseline is the normalized gateway config we restored to.
        let gateway_norm = normalize_cfg_for_switchboard_base(gateway_cfg);
        save_switchboard_base_meta(&config_path, &cli_home, &gateway_norm).expect("save meta");

        // User edits the gateway config after restore.
        let gateway_cfg_edited = "model = \"gpt-5.4\"\n[notice]\nhide_full_access_warning = true\n";
        std::fs::write(cli_cfg_path(&cli_home), gateway_cfg_edited).unwrap();

        let out = read_cfg_base_text(&config_path, &cli_home).expect("read base");
        assert!(out.contains("model = \"gpt-5.4\""));

        // The base file is refreshed to match the latest gateway edits.
        let refreshed = load_switchboard_base_cfg(&config_path, &cli_home).expect("load base");
        assert!(refreshed.contains("model = \"gpt-5.4\""));
    }

    #[test]
    fn switch_to_gateway_home_restores_even_if_base_save_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Make base dir path a file so save_switchboard_base_cfg/meta fails.
        let base_dir = super::switchboard_base_dir_from_config_path(&config_path);
        std::fs::create_dir_all(base_dir.parent().unwrap()).unwrap();
        std::fs::write(&base_dir, "not a dir").unwrap();

        // Swapped CLI home: backups are the gateway config; current is provider mode.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-test"}"#).unwrap();
        std::fs::write(
            cli_cfg_path(&cli_home),
            "model_provider = \"x\"\nmodel = \"gpt-5.2\"\n",
        )
        .unwrap();

        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        switch_to_gateway_home_impl(&state, &cli_home).expect("switch gateway");

        let restored_cfg = std::fs::read_to_string(cli_cfg_path(&cli_home)).unwrap();
        assert!(restored_cfg.contains("model = \"gpt-5.2\""));
        assert!(!swap_state_dir(&cli_home).exists());
    }

    #[test]
    fn model_provider_id_detects_value_even_if_toml_is_invalid() {
        let cfg = concat!(
            "model_provider = \"packycode\"\n",
            "model = \"gpt-5.2\"\n",
            "\n",
            "[tui]\n",
            // invalid TOML: missing closing quote
            "alternate_screen = \"never\n",
        );
        assert_eq!(model_provider_id(cfg).as_deref(), Some("packycode"));
    }

    #[test]
    fn model_provider_id_allows_hash_inside_quotes() {
        let cfg = "model_provider = \"my#provider\"\n";
        assert_eq!(model_provider_id(cfg).as_deref(), Some("my#provider"));
    }

    #[test]
    fn model_provider_id_supports_single_quoted_values() {
        let cfg = "model_provider = 'packycode'\n";
        assert_eq!(model_provider_id(cfg).as_deref(), Some("packycode"));
    }

    #[test]
    fn home_mode_uses_config_provider_when_original() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(
            cli_cfg_path(&cli_home),
            "model_provider = \"codex\"\nmodel = \"gpt-5.2\"\n",
        )
        .unwrap();

        let (mode, provider) = home_mode(&cli_home).expect("home_mode");
        assert_eq!(mode, "provider");
        assert_eq!(provider.as_deref(), Some("codex"));
    }

    #[test]
    fn home_mode_treats_api_router_as_gateway() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(
            cli_cfg_path(&cli_home),
            "model_provider = \"api_router\"\nmodel = \"gpt-5.3-codex\"\n",
        )
        .unwrap();

        let (mode, provider) = home_mode(&cli_home).expect("home_mode");
        assert_eq!(mode, "gateway");
        assert_eq!(provider, None);
    }

    #[test]
    fn model_provider_section_base_url_reads_quoted_section() {
        let cfg = concat!(
            "model_provider = \"codex\"\n",
            "[model_providers.\"codex\"]\n",
            "name = \"codex\"\n",
            "base_url = \"https://code.pumpkinai.vip/v1\"\n",
            "wire_api = \"responses\"\n",
        );
        assert_eq!(
            model_provider_section_base_url(cfg, "codex").as_deref(),
            Some("https://code.pumpkinai.vip/v1")
        );
    }

    #[test]
    fn provider_name_by_base_url_matches_config_provider() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let state = crate::app_state::build_state(config_path, data_dir).expect("state");
        let target_name = {
            let mut cfg = state.gateway.cfg.write();
            let name = cfg
                .providers
                .keys()
                .find(|k| k.as_str() != "official")
                .cloned()
                .expect("at least one non-official provider");
            cfg.providers
                .get_mut(&name)
                .expect("provider exists")
                .base_url = "https://code.pumpkinai.vip/v1".to_string();
            name
        };
        let app_cfg = state.gateway.cfg.read().clone();
        assert_eq!(
            provider_name_by_base_url(&app_cfg, "https://code.pumpkinai.vip/v1").as_deref(),
            Some(target_name.as_str())
        );
    }

    #[test]
    fn provider_name_by_base_url_returns_none_when_ambiguous() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        let state = crate::app_state::build_state(config_path, data_dir).expect("state");
        let target = "https://shared.example.com/v1".to_string();
        {
            let mut cfg = state.gateway.cfg.write();
            let keys = cfg
                .providers
                .keys()
                .filter(|k| k.as_str() != "official")
                .cloned()
                .collect::<Vec<_>>();
            assert!(
                keys.len() >= 2,
                "need at least two non-official providers for ambiguity test"
            );
            cfg.providers
                .get_mut(&keys[0])
                .expect("provider exists")
                .base_url = target.clone();
            cfg.providers
                .get_mut(&keys[1])
                .expect("provider exists")
                .base_url = target.clone();
        }
        let app_cfg = state.gateway.cfg.read().clone();
        assert_eq!(
            provider_name_by_base_url(&app_cfg, "https://shared.example.com/v1"),
            None
        );
    }

    #[test]
    fn normalize_cfg_for_switchboard_base_preserves_user_fields() {
        let cfg = concat!(
            "model_provider = \"packycode\"\n",
            "model = \"gpt-5.3-codex\"\n",
            "\n",
            "[model_providers.\"packycode\"]\n",
            "name = \"packycode\"\n",
            "base_url = \"https://example.com/v1\"\n",
            "\n",
            "[model_providers.\"keep_me\"]\n",
            "name = \"keep_me\"\n",
            "base_url = \"https://keep.me/v1\"\n",
        );
        let out = normalize_cfg_for_switchboard_base(cfg);
        assert!(!out.contains("model_provider ="));
        assert!(out.contains("model = \"gpt-5.3-codex\""));
        assert!(!out.contains("[model_providers.\"packycode\"]"));
        assert!(out.contains("[model_providers.\"keep_me\"]"));
    }

    #[test]
    fn build_direct_provider_cfg_keeps_compact_header_and_preserves_section_order() {
        let cfg = format!(
            concat!(
                "model_provider = \"{provider}\"\n",
                "model = \"gpt-5.2\"\n",
                "model_reasoning_effort = \"medium\"\n",
                "\n",
                "[model_providers.{provider}]\n",
                "name = \"API Router\"\n",
                "base_url = \"http://127.0.0.1:4000\"\n",
                "wire_api = \"responses\"\n",
                "requires_openai_auth = true\n",
                "\n",
                "[notice]\n",
                "hide_full_access_warning = true\n",
                "\n",
                "[tui]\n",
                "alternate_screen = \"never\"\n"
            ),
            provider = GATEWAY_MODEL_PROVIDER_ID
        );

        let out = build_direct_provider_cfg(&cfg, "ppchat", "https://code.ppchat.vip/v1");

        // No extra blank line between model_provider and the next setting.
        assert!(out.contains("model_provider = \"ppchat\"\nmodel = \"gpt-5.2\""));

        // Provider section stays near the top, before [notice], matching the gateway ordering.
        let idx_provider = out.find("[model_providers.\"ppchat\"]").unwrap();
        let idx_notice = out.find("[notice]").unwrap();
        assert!(idx_provider < idx_notice);
    }

    #[test]
    fn build_direct_provider_cfg_removes_gateway_section_case_insensitive() {
        let cfg = concat!(
            "model_provider = \"API_Router\"\n",
            "model = \"gpt-5.2\"\n",
            "\n",
            "[model_providers.API_Router]\n",
            "name = \"API Router\"\n",
            "base_url = \"http://127.0.0.1:4000\"\n",
            "wire_api = \"responses\"\n",
            "requires_openai_auth = true\n",
        );
        let out = build_direct_provider_cfg(cfg, "ppchat", "https://code.ppchat.vip/v1");
        assert!(!out.contains("[model_providers.API_Router]"));
        assert!(!out.contains("[model_providers.api_router]"));
    }

    #[test]
    fn restore_home_original_restores_gateway_cfg_but_preserves_base_for_next_swap() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        let config_path = tmp.path().join("user-data").join("config.toml");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        // Initial gateway files (will be backed up by ensure_backup_exists).
        std::fs::write(cli_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();
        ensure_backup_exists(&cli_home).expect("backup");

        // Simulate swapped state: CLI files reflect a direct provider target, and user edits the model.
        let swapped_cfg = concat!(
            "model_provider = \"packycode\"\n",
            "model = \"gpt-5.3-codex\"\n",
            "\n",
            "[model_providers.\"packycode\"]\n",
            "name = \"packycode\"\n",
            "base_url = \"https://example.com/v1\"\n",
        );
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-test"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), swapped_cfg).unwrap();

        // Persist base (for next swap), then restore gateway config exactly.
        let base_cfg = normalize_cfg_for_switchboard_base(swapped_cfg);
        save_switchboard_base_cfg(&config_path, &cli_home, &base_cfg).expect("save base");
        let gateway_norm = normalize_cfg_for_switchboard_base("model = \"gpt-5.2\"\n");
        save_switchboard_base_meta(&config_path, &cli_home, &gateway_norm).expect("save meta");

        restore_home_original(&cli_home).expect("restore");

        // Gateway config is the original.
        let restored_cfg = std::fs::read_to_string(cli_cfg_path(&cli_home)).unwrap();
        assert!(restored_cfg.contains("model = \"gpt-5.2\""));

        // Switching again should use the preserved base (with the user edit).
        let base_read = read_cfg_base_text(&config_path, &cli_home).expect("base read");
        assert!(base_read.contains("model = \"gpt-5.3-codex\""));
        assert!(!base_read.contains("model_provider ="));
    }

    #[test]
    fn sync_active_provider_target_updates_auth_for_active_provider() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Configure a real provider entry and key in the app state.
        {
            let mut cfg = state.gateway.cfg.write();
            cfg.providers.get_mut("provider_1").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_1", "sk-new")
            .expect("set key");

        // Simulate a swapped Codex CLI home already targeting provider_1.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Mark as swapped by creating backups.
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Current swapped config: direct provider wiring.
        let current_cfg = build_direct_provider_cfg(
            "model = \"gpt-5.2\"\n",
            "provider_1",
            "https://example.com/v1",
        );
        std::fs::write(cli_cfg_path(&cli_home), current_cfg).unwrap();

        // Persist switchboard state so sync knows where to write.
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        sync_active_provider_target_for_key_impl(&state, "provider_1").expect("sync");
        let auth: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cli_auth_path(&cli_home)).unwrap())
                .unwrap();
        assert_eq!(
            auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()),
            Some("sk-new")
        );
    }

    #[test]
    fn on_provider_renamed_updates_state_and_swapped_cli_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Prepare app config: the provider is already renamed in the app-side config.
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        // Swapped Codex CLI home still points at the old provider id.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        let current_cfg = build_direct_provider_cfg(
            "model = \"gpt-5.2\"\n",
            "provider_1",
            "https://example.com/v1",
        );
        std::fs::write(cli_cfg_path(&cli_home), current_cfg).unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        on_provider_renamed_impl(&state, "provider_1", "provider_x").expect("rename hook ok");

        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );

        let cfg_txt = read_text(&cli_cfg_path(&cli_home)).expect("cfg");
        assert_eq!(model_provider_id(&cfg_txt).as_deref(), Some("provider_x"));
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_base_url_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed, but new provider config is invalid (empty base_url).
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url = "".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("base_url"));

        // Even though we error, the state file should be updated to the new provider name.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_key_is_empty() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed, but new provider key is invalid (empty string).
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "")
            .expect("set key");

        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(cli_auth_path(&cli_home), r#"{"OPENAI_API_KEY":"sk-old"}"#).unwrap();
        std::fs::write(cli_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();
        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("key is empty"));

        // Even though we error, the state file should be updated to the new provider name.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }

    #[test]
    fn on_provider_renamed_persists_state_even_if_cli_home_sync_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let config_path = tmp.path().join("user-data").join("config.toml");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

        let state = crate::app_state::build_state(config_path.clone(), data_dir).expect("state");

        // Provider was renamed; new config is valid.
        {
            let mut cfg = state.gateway.cfg.write();
            let p1 = cfg.providers.remove("provider_1").unwrap();
            cfg.providers.insert("provider_x".to_string(), p1);
            cfg.providers.get_mut("provider_x").unwrap().base_url =
                "https://example.com/v1".to_string();
        }
        state
            .secrets
            .set_provider_key("provider_x", "sk-new")
            .expect("set key");

        // Create a swapped CLI home that *looks* like it's targeting provider_1, but is missing
        // auth.json so syncing will fail inside the rewrite loop.
        let cli_home = tmp.path().join("cli-home");
        std::fs::create_dir_all(&cli_home).unwrap();
        std::fs::write(
            cli_cfg_path(&cli_home),
            build_direct_provider_cfg("model = \"gpt-5.2\"\n", "provider_1", "https://x.invalid"),
        )
        .unwrap();

        let state_dir = swap_state_dir(&cli_home);
        std::fs::create_dir_all(&state_dir).unwrap();
        // Backups exist so home_mode treats it as swapped.
        std::fs::write(backup_auth_path(&cli_home), r#"{"tokens":{"t":"x"}}"#).unwrap();
        std::fs::write(backup_cfg_path(&cli_home), "model = \"gpt-5.2\"\n").unwrap();

        // Persist switchboard state (still pointing at provider_1).
        let sw_path = switchboard_state_path_from_config_path(&state.config_path);
        std::fs::create_dir_all(sw_path.parent().unwrap()).unwrap();
        std::fs::write(
            &sw_path,
            serde_json::to_string_pretty(&json!({
              "target": "provider",
              "provider": "provider_1",
              "cli_homes": [cli_home.to_string_lossy().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();

        let err = on_provider_renamed_impl(&state, "provider_1", "provider_x").unwrap_err();
        assert!(err.contains("Missing auth.json") || err.contains("Missing auth.json in"));

        // Even though syncing the CLI home failed, the state should still be updated.
        let sw = read_json(&sw_path).expect("sw json");
        assert_eq!(
            sw.get("provider").and_then(|v| v.as_str()),
            Some("provider_x")
        );
    }
}
