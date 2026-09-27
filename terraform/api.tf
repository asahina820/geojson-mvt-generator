# フロントエンドから呼ぶ API（API Gateway HTTP API + Lambda）
#   POST /jobs                 ジョブ作成 + アップロード用 Presigned URL の発行
#   POST /jobs/{jobId}/start   ECS RunTask で変換を開始
#   GET  /jobs/{jobId}         状態確認 + ダウンロード用 Presigned URL の発行
#
# Lambda のコードは ../api にある。apply の前に `npm run build` で dist/index.mjs を作っておく

# ---- Fargate タスクのネットワーク ----

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# 受信は不要。ECR / S3 / CloudWatch Logs への送信だけ許可する
resource "aws_security_group" "worker" {
  name        = "${var.project_name}-worker"
  description = "Outbound only for MVT worker tasks"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- S3 CORS（ブラウザから Presigned URL で直接 PUT するため） ----

resource "aws_s3_bucket_cors_configuration" "mvt" {
  bucket = aws_s3_bucket.mvt.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["content-type"]
    max_age_seconds = 3600
  }
}

# ---- Lambda ----

resource "aws_iam_role" "api" {
  name = "${var.project_name}-api-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Principal = {
          Service = "lambda.amazonaws.com"
        }

        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role_policy" "api" {
  name = "${var.project_name}-api-policy"
  role = aws_iam_role.api.id

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        # ジョブ情報の読み書きと Presigned URL の署名
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.mvt.arn}/jobs/*"
      },
      {
        # これがないと存在しないオブジェクトの HeadObject が 404 ではなく 403 になる
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.mvt.arn
      },
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.worker.family}:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ecs:DescribeTasks"
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        # RunTask でタスクに Role を渡すために必要
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.ecs_task.arn, aws_iam_role.ecs_execution.arn]
      }
    ]
  })
}

data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../api/dist/index.mjs"
  output_path = "${path.module}/.build/api.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project_name}-api"
  retention_in_days = 7
}

resource "aws_lambda_function" "api" {
  function_name = "${var.project_name}-api"
  role          = aws_iam_role.api.arn

  runtime       = "nodejs22.x"
  architectures = ["arm64"]
  handler       = "index.handler"

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  memory_size = 256
  timeout     = 15

  environment {
    variables = {
      BUCKET          = aws_s3_bucket.mvt.bucket
      CLUSTER         = aws_ecs_cluster.main.name
      TASK_DEFINITION = aws_ecs_task_definition.worker.family
      CONTAINER_NAME  = "mvt-worker"
      SUBNETS         = join(",", data.aws_subnets.default.ids)
      SECURITY_GROUPS = aws_security_group.worker.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# ---- API Gateway ----

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.allowed_origins
    allow_methods = ["GET", "POST"]
    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  for_each = toset([
    "POST /jobs",
    "POST /jobs/{jobId}/start",
    "GET /jobs/{jobId}",
  ])

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # 公開 API なので、呼び出しすぎで Fargate が大量に起動しないよう絞っておく
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
