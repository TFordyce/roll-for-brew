FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json RollForBrew.sln ./
COPY src/RollForBrew.Domain/*.csproj src/RollForBrew.Domain/
COPY src/RollForBrew.Api/*.csproj src/RollForBrew.Api/
COPY tests/RollForBrew.Tests/*.csproj tests/RollForBrew.Tests/
RUN dotnet restore src/RollForBrew.Api/RollForBrew.Api.csproj -r linux-x64 -p:PublishReadyToRun=true
COPY src/ src/
RUN dotnet publish src/RollForBrew.Api/RollForBrew.Api.csproj -c Release -r linux-x64 --self-contained false \
    -p:PublishReadyToRun=true -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /out .
COPY schema-version.tx[t] ./
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "RollForBrew.Api.dll"]
