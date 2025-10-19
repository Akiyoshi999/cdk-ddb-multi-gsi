# envを読み込む
include .env
deploy:
	cdk deploy --profile $(AWS_PROFILE)

destroy:
	cdk destroy --profile $(AWS_PROFILE)

