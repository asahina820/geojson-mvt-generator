output "s3_bucket_name" {
  value = aws_s3_bucket.mvt.bucket
}

output "ecr_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_task_role_arn" {
  value = aws_iam_role.ecs_task.arn
}

output "ecs_task_definition_arn" {
  value = aws_ecs_task_definition.worker.arn
}

output "cloudwatch_log_group_name" {
  value = aws_cloudwatch_log_group.mvt_worker.name
}

# フロントエンドの VITE_API_BASE_URL に設定する
output "api_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}
