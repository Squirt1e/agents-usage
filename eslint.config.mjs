import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `target/` is Rust build output and `.dsh/` holds the repository-local cargo
  // cache (see tools/cargo.sh): both contain third-party JavaScript sources that
  // are not part of this project.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'target/**', '.dsh/**', 'src-tauri/gen/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/tooling scripts run in Node and print through the console. The full
    // Node global set is used rather than a hand-kept list, so a script reaching
    // for `setInterval` or `fetch` does not turn into a lint failure.
    files: ['scripts/**/*.mjs', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
);
