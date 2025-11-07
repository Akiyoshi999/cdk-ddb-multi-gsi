# Repository Guidelines

## プロジェクト構成とモジュール整理
- `bin/` は CDKアプリを起動するエントリースクリプトを収め、実行エントリーを一本化します。
- `lib/` は DynamoDBテーブルやGSIを定義する主要スタックを配置し、インフラ変更はここに集約します。
- `lambda/src/` は テーブル操作用のLambdaハンドラーを配置し、依存関係は `lambda/package.json` で管理します。
- `test/` は Jestのテストケース、`docs/` と `generated-diagrams/` は 設計情報を保存し レビューの補助とします。
- `cdk.out/` は 合成物やテンプレートを含むため、差分レビューでは コミット対象に含めないでください。

## ビルド・テスト・開発コマンド
- `npm run build` は TypeScript を コンパイルし、CDK が参照する JavaScript と テンプレートを生成します。
- `npm run watch` は 増分コンパイルを実行し、スタックや Lambda を 編集する際の フィードバックを高速化します。
- `npm run test` は ts-jest 経由で Jest を 実行し、単体テストと 型整合性 を 同時に確認します。
- `npm run cdk synth` と `npm run cdk diff` は デプロイ前の確認手順とし、`npm run cdk deploy` で 本番アカウントへ 反映します。
- Makefile の `make deploy` と `make destroy` は `.env` の `AWS_PROFILE` を 使って プロファイル切替を 簡略化します。

## コーディングスタイルと命名規約
- TypeScript ファイルは 2 スペースインデント、セミコロンあり、Arrow Function を 優先します。
- CDK コンストラクトや Stack クラスは `PascalCase`、ハンドラー関数や 変数は `camelCase` を 用いて 一貫性を 保ちます。
- DynamoDB リソースの 物理名は `ServiceContextPurpose` 形式を 採用し、図面や README と 同期します。
- 自動整形ツールは 未導入 のため `tsc --noEmit` を 使って 型エラーを 排除し、必要に応じて `eslint` を ローカルで 併用してください。

## テスト指針
- テストファイルは `test/stack-name.test.ts` の ように 対象を 明示する 命名を 用います。
- テーブル操作を 行う Lambda では AWS SDK クライアントを モックし、正常系と エラーパス を 両方 確認します。
- CDK スタックには `expect(stack).toHaveResourceLike` を 活用し、テーブルと GSI と Lambda イベントソース を 検証します。
- PR 提出時は `npm run test` と `npm run cdk synth` の 実行結果を 記載し、レビューアー が 再現せずに 状態を 把握できる ように します。

## コミットと Pull Request ガイドライン
- コミットメッセージは 英語の 命令形 で 50 文字以内 を 目標 に し、連続する 機能改修 は 複数 コミット に 分割 します。
- PR 説明には 目的、 主な 変更点、 実行した 検証コマンド、 関連 チケット ID を 箇条書き で 明記 します。
- CDK リソースの 変更を 含む 場合は 影響レンジ、 既存 データへの 配慮、 ロールバック 手順 を コメント で 補足 します。
- 図や サンプルデータ を 更新した 場合は 対応する `docs/` や `generated-diagrams/` の 差分 を PR に 添付 して 可視化 します。

## CDK と 環境設定 のヒント
- `cdk.context.json` を 共有する 際は 機密値 を 含めず `context` 情報 を 明文化 し、手動 で 復元 できる ように します。
- `AWS_PROFILE=dev npm run cdk deploy` の ように プロファイル を 明示 し、誤った アカウント への デプロイ を 防止 します。
- 初回 デプロイ 前に `npx cdk bootstrap` の 実行状態 を 確認 し、環境 ごとの Bootstrap スタック を 管理 します。
