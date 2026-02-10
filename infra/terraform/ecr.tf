# =============================================================================
# Elastic Container Registry (ECR)
# =============================================================================

locals {
  ecr_repos = ["veradigm-fhir-mcp", "veradigm-unity-mcp", "veradigm-admin-portal"]
}

resource "aws_ecr_repository" "repos" {
  for_each = toset(local.ecr_repos)

  name                 = each.value
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment == "sandbox"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = each.value }
}

# --- Lifecycle policy: keep last 10 images, expire untagged after 7 days ---
resource "aws_ecr_lifecycle_policy" "cleanup" {
  for_each   = aws_ecr_repository.repos
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only last 10 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = ["latest"]
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
