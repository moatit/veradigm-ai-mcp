# =============================================================================
# IAM Roles & Policies
# =============================================================================

# -----------------------------------------------------------------------------
# EC2 Instance Role — ECR pull, SSM, Parameter Store
# -----------------------------------------------------------------------------

resource "aws_iam_role" "ec2" {
  name = "veradigm-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# SSM Managed Instance Core (for Session Manager access)
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ECR Read-Only
resource "aws_iam_role_policy_attachment" "ec2_ecr" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# SSM Parameter Store read access
resource "aws_iam_role_policy" "ec2_ssm_params" {
  name = "veradigm-ec2-ssm-params"
  role = aws_iam_role.ec2.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ]
      Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/veradigm/*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "veradigm-ec2-profile"
  role = aws_iam_role.ec2.name
}

# -----------------------------------------------------------------------------
# NOTE: GitHub Actions uses IAM Access Keys (not OIDC).
# The deploy IAM user (Veradigm-ai-deploy) is managed via AWS Console.
# -----------------------------------------------------------------------------
