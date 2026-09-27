# S3: 入力 GeoJSON（input/）と変換結果（output/）を置くバケット。公開しない
resource "aws_s3_bucket" "mvt" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "mvt" {
  bucket = aws_s3_bucket.mvt.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ECR: mvt-docker のイメージを置くリポジトリ
resource "aws_ecr_repository" "worker" {
  name = "${var.project_name}-worker"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# ECS: Fargate タスクを動かすクラスター
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
}

# IAM: Fargate 上のコンテナが使う Role
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }

        Action = "sts:AssumeRole"
      }
    ]
  })
}

# コンテナから S3 の読み書き（input の取得、output の配置）を許可
resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "${var.project_name}-s3-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Action = [
          "s3:GetObject",
          "s3:PutObject"
        ]

        Resource = "${aws_s3_bucket.mvt.arn}/*"
      }
    ]
  })
}

# IAM: ECS 自身が使う Role（ECR からのイメージ取得、CloudWatch Logs へのログ送信）
# コンテナ内の convert.sh が使う権限は ecs_task 側
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"

    Statement = [
      {
        Effect = "Allow"

        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }

        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# CloudWatch Logs: convert.sh の出力先
resource "aws_cloudwatch_log_group" "mvt_worker" {
  name              = "/ecs/${var.project_name}-worker"
  retention_in_days = 7
}

# ECS Task Definition: mvt-worker を Fargate で動かす設定
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-worker"
  requires_compatibilities = ["FARGATE"]

  network_mode = "awsvpc"

  cpu    = "2048"
  memory = "4096"

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  # Apple Silicon の Mac で build したイメージは ARM64
  # （--platform linux/amd64 で build した場合は X86_64 にする）
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  ephemeral_storage {
    size_in_gib = 50
  }

  container_definitions = jsonencode([
    {
      name  = "mvt-worker"
      image = "${aws_ecr_repository.worker.repository_url}:latest"

      essential = true

      environment = [
        {
          name  = "INPUT_S3"
          value = "s3://${aws_s3_bucket.mvt.bucket}/input/test.geojson"
        },
        {
          name  = "OUTPUT_S3"
          value = "s3://${aws_s3_bucket.mvt.bucket}/output/test.zip"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"

        options = {
          awslogs-group         = aws_cloudwatch_log_group.mvt_worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])
}
