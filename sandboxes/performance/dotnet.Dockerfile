# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG PROJECT
WORKDIR /src
COPY . .
RUN --mount=type=secret,id=nuget_token \
    GITHUB_PERSONAL_ACCESS_TOKEN="$(cat /run/secrets/nuget_token 2>/dev/null || true)" \
    dotnet publish "$PROJECT" -c Release -o /out /p:UseAppHost=false /p:UseSharedCompilation=false
# Only explicit sandbox configuration belongs in the runtime image.
RUN rm -f /out/appsettings*.json && printf '%s' '{}' > /out/appsettings.json
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
USER app
ENTRYPOINT ["sh", "-c", "exec dotnet \"$APP_DLL\""]
